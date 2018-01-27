'use strict'
const crypto = require('crypto')
const debug = require('debug')('ilp-plugin-ethereum-asym-client')
const BtpPacket = require('btp-packet')
const BigNumber = require('bignumber.js')
const Web3 = require('web3')
const Machinomy = require('machinomy').default
const Payment = require('machinomy/lib/payment').default
const PluginMiniAccounts = require('ilp-plugin-mini-accounts')
const StoreWrapper = require('./src/store-wrapper')
const Account = require('./src/account')

class Plugin extends PluginMiniAccounts {
  constructor (opts) {
    super(opts)
    this._account = opts.account
    this._db = opts.db || 'machinomy_db'
    this._provider = opts.provider || 'http://localhost:8545'
    this._minimumChannelAmount = opts.minimumChannelAmount || 100
    this._web3 = new Web3(typeof this._provider === 'string'
      ? new Web3.providers.HttpProvider(this._provider)
      : this._provider)

    this._bandwidth = 0
    this._store = new StoreWrapper(opts._store)

    this._channelToAccount = new Map()
    this._accounts = new Map()
  }

  _getAccount (from) {
    const accountName = this.ilpAddressToAccount(from)
    let account = this._accounts.get(accountName)

    if (!account) {
      account = new Account({
        account: accountName,
        store: this._store
      })
      this._accounts.set(accountName, account)
    }

    return account
  }

  _extraInfo (account) {
    return {
      ethereumAccount: this._account,
      account: this._prefix + account.getAccount()
    }
  }

  async _preConnect () {
    this._machinomy = new Machinomy(this._account, this._web3, {
      engine: 'nedb',
      databaseFile: this._db,
      minimumChannelAmount: this._minimumChannelAmount
    })
  }

  async _connect (address, { requestId, data }) {
    const account = this._getAccount(address)
    await account.connect()

    // TODO: you need to send some money up front to
    // cover the costs of this channel
    // (should be 2 tx fees worth)
    /*
    const clientChannel = account.getClientChannel()
    if (!clientChannel) {
      // TODO: create an outgoing channel
      // account.setClientChannel( TODO )
    }
    */

    return null
  }

  async _handleCustomData (from, { requestId, data }) {
    const { ilp, protocolMap } = this.protocolDataToIlpAndCustom(data)
    const account = this._getAccount(from)

    if (protocolMap.info) {
      return [{
        protocolName: 'info',
        contentType: BtpPacket.MIME_APPLICATION_JSON,
        data: Buffer.from(JSON.stringify(this._extraInfo(account)))
      }]
    } else if (protocolMap.ilp) {
      let response = await Promise.race([
        this._dataHandler(ilp.data),
        this._expireData(account, ilp.data)
      ])

      if (ilp.data[0] === IlpPacket.Type.TYPE_ILP_PREPARE) {
        if (response[0] === IlpPacket.Type.TYPE_ILP_REJECT) {
          this._rejectIncomingTransfer(account, ilp.data)
        } else if (response[0] === IlpPacket.Type.TYPE_ILP_FULFILL) {
          // TODO: should await, or no?
          const { amount } = IlpPacket.deserializeIlpPrepare(ilp.data)
          if (amount !== '0' && this._moneyHandler) this._moneyHandler(amount)
        }
      }

      return this.ilpAndCustomToProtocolData({ ilp: response })
    }
  }

  async _expireData (account, ilpData) {
    const isPrepare = ilpData[0] === IlpPacket.Type.TYPE_ILP_PREPARE
    const expiresAt = isPrepare
      ? IlpPacket.deserializeIlpPrepare(ilpData).expiresAt
      : new Date(Date.now() + DEFAULT_TIMEOUT) // TODO: other timeout as default?

    await new Promise((resolve) => setTimeout(resolve, expiresAt - Date.now()))
    return isPrepare
      ? IlpPacket.serializeIlpReject({
        code: 'F00',
        triggeredBy: this._prefix, // TODO: is that right?
        message: 'expired at ' + new Date().toISOString(),
        data: Buffer.from('')
      })
      : IlpPacket.serializeIlpError({
        code: 'F00',
        name: 'Bad Request',
        triggeredBy: this._prefix + account.getAccount(),
        forwardedBy: [],
        triggeredAt: new Date(),
        data: JSON.stringify({
          message: `request timed out after ${DEFAULT_TIMEOUT} ms`
        })
      })
  }

  _handleIncomingPrepare (account, ilpData) {
    const { amount } = IlpPacket.deserializeIlpPrepare(ilpData)

    const secured = account.getSecuredBalance()
    const prepared = account.getBalance()
    const newPrepared = prepared.add(amount)
    const unsecured = newPrepared.sub(secured)
    debug(unsecured.toString(), 'unsecured; secured balance is',
      lastValue.toString(), 'prepared amount', amount, 'newPrepared',
      newPrepared.toString(), 'prepared', prepared.toString())

    if (unsecured.greaterThan(this._bandwidth)) {
      throw new Error('Insufficient bandwidth, used: ' + unsecured + ' max: ' +
        this._bandwidth)
    }

    account.setBalance(newPrepared.toString())
    debug(`account ${account.getAccount()} debited ${amount} units, new balance ${newPrepared.toString()}`)
  }

  _rejectIncomingTransfer (account, ilpData) {
    const { amount } = IlpPacket.deserializeIlpPrepare(ilpData)
    const prepared = account.getBalance()
    const newPrepared = prepared.sub(amount)

    account.setBalance(newPrepared.toString())
    debug(`account ${account.getAccount()} roll back ${amount} units, new balance ${newPrepared.toString()}`)
  }

  _handlePrepareResponse (destination, parsedResponse, preparePacket) {
    debug('got prepare response', parsedResponse)
    if (parsedResponse.type === IlpPacket.Type.TYPE_ILP_FULFILL) {
      if (!crypto.createHash('sha256')
        .update(parsedResponse.data.fulfillment)
        .digest()
        .equals(preparePacket.data.executionCondition)) {
          // TODO: could this leak data if the fulfillment is wrong in
          // a predictable way?
        throw new Error(`condition and fulfillment don't match.
            condition=${preparePacket.data.executionCondition}
            fulfillment=${parsedResponse.data.fulfillment}`)
      }

      // send off a transfer in the background to settle
      /* TODO: only do this once we've sorted the fee thing
      util._requestId()
        .then((requestId) => {
          return this._call(destination, {
            type: BtpPacket.TYPE_TRANSFER,
            requestId,
            data: {
              amount: preparePacket.data.amount,
              protocolData: this._sendMoneyToAccount(
                preparePacket.data.amount,
                destination)
            }
          })
        })
        .catch((e) => {
          debug(`failed to pay account.
            destination=${destination}
            error=${e && e.stack}`)
        }) */
    }
  }

  async _sendMoneyToAccount (transferAmount, to) {
    const account = this._getAccount(to)
    const payment = await this._machinomy.nextPayment(
      account.getClientChannel(),
      new BigNumber(transferAmount),
      '')

    return [{
      protocolName: 'machinomy',
      contentType: BtpPacket.MIME_APPLICATION_JSON,
      data: Buffer.from(JSON.stringify(payment))
    }]
  }

  async _handleMoney (from, { requestId, data }) {
    const account = this._getAccount(from)
    const primary = data.protocolData[0]
    if (primary.protocolName === 'machinomy') {
      const payment = new Payment(JSON.parse(primary.data.toString()))
      console.log("GOT PAYMENT", payment)
      await this._machinomy.acceptPayment(payment)
      const secured = account.getSecuredBalance()
      const newSecured = secured.add(payment.price)
      account.setSecuredBalance(newSecured.toString())
      debug('got money. secured=' + secured.toString(),
        'new=' + newSecured.toString())
    }
  }
}

module.exports = Plugin