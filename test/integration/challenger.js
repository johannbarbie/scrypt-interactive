/*
This tests the client's functionality on the challenger side of things. Code is meant to simulate the claimant by proxy.
*/

require('dotenv').config()
require('../helpers/chai').should()
web3.eth.defaultAccount = web3.eth.accounts[0]

const miner = require('../helpers/miner')(web3)
const getAllEvents = require('../helpers/events').getAllEvents
const getContracts = require('../../client/util/getContracts')

const {
  serializedBlockHeader,
  scryptHash,
  fakeTestScryptHash,
} = require('../helpers/blockheader')

describe('Challenger Client Integration Tests', function () {
  // set max timeout to 120 seconds
  this.timeout(120000)

  let bridge, claimant, challenger, otherClaimant
  let monitor, stopMonitor

  before(async () => {
    const contracts = await (await getContracts(web3)).deploy()
    bridge = await require('../../client')(web3, contracts)

    claimant = web3.eth.accounts[1]
    challenger = web3.eth.accounts[2]
    otherClaimant = web3.eth.accounts[3]
  })

  after(async () => {
    // teardown processes
    stopMonitor()
    await monitor
  })

  describe('Challenger reacting to verificaiton game', () => {
    it('should start monitoring claims', async () => {
      // eslint-disable-next-line
      const stopper = new Promise((resolve) => stopMonitor = resolve)
      monitor = bridge.monitorClaims(console, challenger, stopper, true, true)
    })

    it('should let claimant make a deposit and create claim', async () => {
      // early indicator if contract deployment is correct
      await bridge.api.makeDeposit({ from: claimant, value: 1 })

      let deposit = await bridge.api.getDeposit(claimant)
      deposit.should.be.bignumber.equal(1)

      await bridge.api.createClaim(
        serializedBlockHeader,
        scryptHash,
        claimant,
        'bar',
        { from: claimant, value: 1 }
      )
    })

    it('should be zero challengers', async () => {
      //challenger sees proof of work is valid and does not challenge
      bridge.api.claimManager.ClaimCreated({}, {fromBlock: 0, toBlock: 'latest'}).get( async (err, result) => {
        if(err) console.log(err)
        if(result) {
          assert.equal(0, (await bridge.api.claimManager.getChallengers(result[0].args.claimID.toNumber())).length)
        }
      })
    })

    it('should let other claimant make a deposit and create claim', async () => {
      // early indicator if contract deployment is correct
      await bridge.api.makeDeposit({ from: otherClaimant, value: 1 })

      let deposit = await bridge.api.getDeposit(otherClaimant)
      deposit.should.be.bignumber.equal(1)

      await bridge.api.createClaim(
        serializedBlockHeader,
        fakeTestScryptHash,
        otherClaimant,
        'bar',
        { from: otherClaimant, value: 1 }
      )
    })

    it('should let claimant make a deposit and check scrypt', async () => {
      await bridge.api.createClaim(
        serializedBlockHeader,
        scryptHash,
        claimant,
        'bar',
        { from: claimant, value: 1 }
      )
      await miner.mineBlocks(4)
    })

    it(`should query to normal case medHash==0x0 step ${i}`, async () => {
      let verificationGameOngoing = true
      while (verificationGameOngoing) {
        const result = await getAllEvents(bridge.api.scryptVerifier, 'NewQuery')
        result.length.should.be.gt(0)

        const sessionId = result[0].args.sessionId.toNumber()
        const _claimant = result[0].args.claimant
        assert.equal(_claimant, claimant)

        const session = await bridge.api.getSession(sessionId)
        const step = session.medStep.toNumber()
        const highStep = session.highStep.toNumber()
        const lowStep = session.lowStep.toNumber()
        console.log("low step: " + lowStep + " | high step: " + highStep)

        if (lowStep + 1 === highStep) {
          verificationGameOngoing = false
        } else {
          const results = await bridge.api.getResult(session.input, step)

          await bridge.api.respond(sessionId, step, results.stateHash, { from: otherClaimant })
        }
      }
    })

    it('should query special case medHash!=0x0', async () => {
      const result = await getAllEvents(bridge.api.scryptVerifier, 'NewQuery')

      result.length.should.be.gt(0)

      let sessionId = result[0].args.sessionId.toNumber()
      let _claimant = result[0].args.claimant
      _claimant.should.equal(otherClaimant)

      let session = await bridge.api.getSession(sessionId)
      // let step = session.medStep.toNumber()
      let highStep = session.highStep.toNumber()
      let lowStep = session.lowStep.toNumber()

      let preState = (await bridge.api.getResult(session.input, lowStep)).state

      let postStateAndProof = await bridge.api.getResult(session.input, highStep)

      let postState = postStateAndProof.state
      let proof = postStateAndProof.proof || '0x00'

      let claimID = (await bridge.api.claimManager.claimantClaims(otherClaimant)).toNumber()

      await bridge.api.scryptVerifier.performStepVerification(
        sessionId,
        claimID,
        preState,
        postState,
        proof,
        bridge.api.claimManager.address,
        { from: otherClaimant, gas: 3000000 }
      )
    })

    it('should end verification game', async () => {
      console.log(await getAllEvents(bridge.api.scryptVerifier, 'ClaimantConvicted'))
      console.log(await getAllEvents(bridge.api.scryptVerifier, 'ChallengerConvicted'))
    })
  })
})
