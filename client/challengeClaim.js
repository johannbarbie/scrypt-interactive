const StateMachine = require('javascript-state-machine')
const waitForEvent = require('./util/waitForEvent')
const timeout = require('./util/timeout')
const calculateMidpoint = require('./util/math').calculateMidpoint
const fs = require('fs')
const promisify = require('es6-promisify')
const mkdirp = promisify(require('mkdirp'))
const models = require('./util/models')

const writeFile = promisify(fs.writeFile, fs)
const unlink = promisify(fs.unlink, fs)
const path = require('path')

const challengeCachePath = path.resolve(__dirname, '../../cache/challenges')

const saveChallengeData = async (data) => {
  await mkdirp(challengeCachePath)
  await writeFile(`${challengeCachePath}/${data.id}.json`, JSON.stringify(data))
}

const deleteChallengeData = async (data) => unlink(`${challengeCachePath}/${data.id}.json`)

module.exports = (web3, api) => ({
  run: async (cmd, claim, challenger, autoDeposit = false) => new Promise(async (resolveChallenge, reject) => {

    const getNewMedStep = async (sessionId) => {
      let session = await api.getSession(sessionId)
      let medStep = session.medStep.toNumber()

      let result = await api.getResult(session.input, medStep)
      if(result.stateHash == session.medHash) {
        return calculateMidpoint(session.medStep.toNumber(), session.highStep.toNumber())
      }else{
        return calculateMidpoint(session.lowStep.toNumber(), session.medStep.toNumber())
      }
    }

    try {
      const { claimManager } = api

      let sessionId

      const m = new StateMachine({
        init: 'init',
        transitions: [
          { name: 'start', from: 'init', to: 'ready' },
          { name: 'challenge', from: 'ready', to: 'didChallenge' },
          { name: 'playGame', from: 'didChallenge', to: 'done'},
          { name: 'cancel', from: '*', to: 'cancelled' },
          { name: 'skipChallenge', from: 'ready', to: 'didChallenge'}
        ],
        methods: {
          onStart: async (tsn) => {
            if('sessionId' in claim) {
              return true;
            }else{
              cmd.log('Checking deposits...')

              const minDeposit = await api.getMinDeposit()
              const currentDeposit = await api.getDeposit(challenger)
              if (currentDeposit.lt(minDeposit)) {
                cmd.log('Not enough ETH deposited.')
                // if we don't have enough deposit, either add some or throw
                // let's just add exactly the right amount for now
                if (autoDeposit) {
                  const neededAmount = minDeposit.sub(currentDeposit)
                  const myBalance = await api.getBalance(challenger)
                  if (myBalance.gte(neededAmount)) {
                    cmd.log(`Depositing ${web3.fromWei(neededAmount, 'ether')} ETH...`)
                    await api.makeDeposit({from: challenger, value: neededAmount})
                    cmd.log(`Deposited ${web3.fromWei(neededAmount, 'ether')} ETH.`)
                  } else {
                    throw new Error(`
                      You don't have enough ETH to submit a deposit that would be greater than minDeposit.
                    `)
                  }
                } else {
                  throw new Error(`
                    Your deposited ETH in ClaimManager is lower than minDeposit and --deposit was not enabled.`
                  )
                }
              }
              return false;
            }
          },
          onBeforeChallenge: async (tsn) => {
            cmd.log('Challenging...')
            //console.log(claim.id)
            if(!('sessionId' in claim)) {
              await api.challengeClaim(claim.id, {from: challenger})//bonds deposit
            }
          },
          onAfterChallenge: async (tsn) => {

            //When this function is called play game is expected to start
            const sendQuery = async () => {
              claim.sessionId = await api.claimManager.getSession.call(claim.id, challenger)
              //Initial query
              await saveChallengeData(claim)

              let session = await api.getSession(claim.sessionId)
              let medStep = calculateMidpoint(session.lowStep.toNumber(), session.highStep.toNumber())
              await api.query(claim.sessionId, medStep, {from: challenger})
            }

            const waitForGame = async () => {
              const verificationGameStartedEvent = api.claimManager.VerificationGameStarted({claimID: claim.id, challenger: challenger})
              return new Promise(async (resolve, reject) => {
                verificationGameStartedEvent.watch(async (err, result) => {
                  if(err) reject(err)
                  if(result) resolve()
                })
              })
              verificationGameStartedEvent.stopWatching()
            }

            //Figure out if first challenger
            let currentChallenger = await api.claimManager.getCurrentChallenger.call(claim.id)
            let verificationOngoing = await api.claimManager.getVerificationOngoing.call(claim.id)

            if (currentChallenger == challenger && !verificationOngoing) {
              console.log('... we are first challenger.')
              await api.claimManager.runNextVerificationGame(claim.id, {from: challenger})
              await sendQuery()
            } else if (currentChallenger == challenger && verificationOngoing) {
              // ^ should only happen if rebooting during game
              console.log('... resuming challenge.')
              let [
                claimantLastStep, challengerLastStep
              ] = await api.scryptVerifier.getLastSteps.call(claim.sessionId)

              if(claimantLastStep.toNumber() == challengerLastStep.toNumber()) {
                console.log("Querying step: " + medStep)
                await sendQuery()
              }
              //else wait for next query by starting game
            } else if (currentChallenger != challenger && verificationOngoing) {
              console.log('... waiting')
              await waitForGame()
              await sendQuery()
            } else {
              // ^ this case probably won't happen but this should cover us if it does
              console.log('... ???')
              await api.claimManager.runNextVerificationGame(claim.id, {from: challenger})
              await waitForGame()
              await sendQuery()
            }

          },
          onBeforePlayGame: async (tsn) => {
            const endGame = async () => {

              let session = await api.getSession(sessionId)
              // let step = session.medStep.toNumber()
              let highStep = session.highStep.toNumber()
              let lowStep = session.lowStep.toNumber()
        
              let preState = (await api.getResult(session.input, lowStep)).state
        
              let postStateAndProof = await api.getResult(session.input, highStep)
        
              let postState = postStateAndProof.state
              let proof = postStateAndProof.proof || '0x00'

              await api.scryptVerifier.performStepVerification(
                claim.sessionId,
                claim.id,
                preState,
                postState,
                proof,
                bridge.api.claimManager.address,
                { from: challenger, gas: 3000000 }
              )
            }

            //playGame
            let newResponseEvent = api.scryptVerifier.NewResponse({sessionId: claim.sessionId, challenger: challenger})
            await new Promise(async (resolve, reject) => {
              newResponseEvent.watch(async (err, result) => {
                if(err) reject(err)
                if(result) {

                  let medStep = await getNewMedStep(claim.sessionId)
                  console.log("Querying step: " + medStep)
                  await api.query(claim.sessionId, medStep, {from: challenger})
                  if(medStep == 0) resolve()
                }
              })
            })
            newResponseEvent.stopWatching()
          },
          onAfterPlayGame: async (tsn) => {
            
            let sessionDecidedEvent = api.claimManager.SessionDecided({sessionId: claim.sessionId})
            await new Promise((resolve, reject) => {
              sessionDecidedEvent.watch(async (err, result) => {
                if(err) reject(err)
                if(result) {
                  console.log(result)
                  resolve()
                }
              })
            })
            sessionDecidedEvent.stopWatching()
            await deleteChallengeData(claim)
            resolve()
          },
          onCancel: (tsn, err) => { reject(err) },
        }
      })

      //FSM high level transitions
      if(await m.start()) {
        await m.playGame()
      }else{
        await m.challenge()
        await m.playGame()
      }

    } catch (error) {
      reject(error)
    }
  }),
})