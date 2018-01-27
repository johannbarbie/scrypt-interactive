/*
This tests the client's functionality on the challenger side of things. Code is meant to simulate the claimant by proxy.
*/

require('dotenv').config()
const Web3 = require('web3')
const web3 = new Web3(new Web3.providers.HttpProvider(process.env.WEB3_HTTP_PROVIDER))

require('../helpers/chai').should()
const getAllEvents = require('../helpers/events').getAllEvents

const ClaimManager = artifacts.require('ClaimManager')
const ScryptVerifier = artifacts.require('ScryptVerifier')
const DogeRelay = artifacts.require('DogeRelay')

// eslint-disable-next-line max-len
const serializedBlockHeader = '0x03000000c63abe4881f9c765925fffb15c88cdb861e86a32f4c493a36c3e29c54dc62cf45ba4401d07d6d760e3b84fb0b9222b855c3b7c04a174f17c6e7df07d472d0126fe455556358c011b6017f799'
const testScryptHash = '0x3569d4c55c658997830bce8f904bf4cb74e63cfcc8e1037a5fab030000000000'

const timeout = require('../helpers/timeout')
const models = require(__dirname + '/../../client/util/models')

describe('Challenger Client Integration Tests', function () {
  // set max timeout to 120 seconds
  this.timeout(120000)

  let bridge, claimant, challenger, dogeRelay, contracts
  let monitor, stopMonitor

  before(async () => {
    scryptVerifier = await ScryptVerifier.new()
    claimManager = await ClaimManager.new(scryptVerifier.address)
    scryptRunner = await require('../helpers/offchain').scryptRunner()
    dogeRelay = await DogeRelay.new(claimManager.address)

    contracts = {
      scryptVerifier: scryptVerifier,
      claimManager: claimManager,
      scryptRunner: scryptRunner,
      dogeRelay: dogeRelay
    }

    bridge = await require('../../client')(web3, contracts)
    let accounts = web3.eth.accounts
    claimant = accounts[1]
    challenger = accounts[2]
    await bridge.api.claimManager.setDogeRelay(dogeRelay.address, {from: claimant})
  })

  after(async () => {
    // teardown processes
    stopMonitor()
    await monitor
  })

  describe('Challenger reacting to verificaiton game', () => {
    it('should let claimant make a deposit and check scrypt', async () => {
      // early indicator if contract deployment is correct
      await bridge.api.makeDeposit({ from: claimant, value: 1 })

      let deposit = await bridge.api.getDeposit(claimant)
      deposit.should.be.bignumber.equal(1)

      await bridge.api.createClaim(
        serializedBlockHeader, 
        testScryptHash, 
        claimant, 
        'bar', 
        { from: claimant, value: 1 }
      )
    })

    it('should start monitoring claims', async () => {
      // eslint-disable-next-line
      const stopper = new Promise((resolve) => stopMonitor = resolve)
      monitor = bridge.monitorClaims(console, challenger, stopper, true, true)
    })

    it('should query to normal case medHash==0x0', async () => {

      await timeout(3000)

      await new Promise(async (resolve, reject) => {
        for(i = 0; i < 11; i++) {
          await timeout(5000)
          const result = await getAllEvents(bridge.api.scryptVerifier, 'NewQuery')
          result.length.should.be.gt(0)
  
          let sessionId = result[0].args.sessionId.toNumber()
          let _claimant = result[0].args.claimant
          assert.equal(_claimant, claimant)
  
          let session = await bridge.api.getSession(sessionId)
          let step = session.medStep.toNumber()
          // let highStep = session.highStep.toNumber()
          // let lowStep = session.lowStep.toNumber()
  
          let results = await bridge.api.getResult(session.input, step)
  
          await bridge.api.respond(sessionId, step, results.stateHash, { from: claimant })
        }
        resolve()
      })
    })

    it('should query special case medHash!=0x0', async () => {
      await timeout(5000)
      const result = await getAllEvents(bridge.api.scryptVerifier, 'NewQuery')

      result.length.should.be.gt(0)

      let sessionId = result[0].args.sessionId.toNumber()
      let _claimant = result[0].args.claimant
      _claimant.should.equal(claimant)

      let session = await bridge.api.getSession(sessionId)
      // let step = session.medStep.toNumber()
      let highStep = session.highStep.toNumber()
      let lowStep = session.lowStep.toNumber()

      let preState = (await bridge.api.getResult(session.input, lowStep)).state

      let postStateAndProof = await bridge.api.getResult(session.input, highStep)

      let postState = postStateAndProof.state
      let proof = postStateAndProof.proof || '0x00'

      let claimID = (await bridge.api.claimManager.claimantClaims(claimant)).toNumber()

      await bridge.api.scryptVerifier.performStepVerification(
        sessionId,
        claimID,
        preState,
        postState,
        proof,
        bridge.api.claimManager.address,
        { from: claimant, gas: 3000000 }
      )
    })

    it('should end verification game', async () => {
      await timeout(5000)

      console.log(await getAllEvents(bridge.api.scryptVerifier, 'ClaimantConvicted'))
      console.log(await getAllEvents(bridge.api.scryptVerifier, 'ChallengerConvicted'))
    })
  })
})
