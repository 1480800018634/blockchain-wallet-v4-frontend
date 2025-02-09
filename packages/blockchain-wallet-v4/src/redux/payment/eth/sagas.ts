import BigNumber from 'bignumber.js'
import EthUtil from 'ethereumjs-util'
import {
  identity,
  indexOf,
  isNil,
  mergeRight,
  path,
  prop,
  toLower
} from 'ramda'
import { call, select } from 'redux-saga/effects'

import { EthRawTxType } from 'core/types'

import settingsSagaFactory from '../../../redux/settings/sagas'
import { eth } from '../../../signer'
import { isPositiveInteger, isString } from '../../../utils/checks'
import {
  calculateEffectiveBalance,
  calculateFee,
  convertGweiToWei,
  isValidAddress
} from '../../../utils/eth'
import * as S from '../../selectors'
import { ADDRESS_TYPES } from '../btc/utils'
import { FETCH_FEES_FAILURE } from '../model'
import { AddressTypesType } from '../types'
import { isValidIndex } from './utils'

const taskToPromise = t =>
  new Promise((resolve, reject) => t.fork(reject, resolve))

/**
  Usage:
    // sequential
    let payment = create({ network })

    // chained
    let payment = yield create({ network })
      .chain().amount(myAmount).done()
*/

export default ({ api }) => {
  const settingsSagas = settingsSagaFactory({ api })
  const selectIndex = function * (from) {
    const appState = yield select(identity)
    switch (prop('type', from)) {
      case ADDRESS_TYPES.ACCOUNT:
        return S.kvStore.eth
          .getAccountIndex(appState, prop('address', from))
          .getOrFail('Could not find ether account index')
      case ADDRESS_TYPES.LEGACY:
        return 1
    }
  }

  const calculateIsSufficientEthForErc20 = function * (fee) {
    const ethBalanceR = yield select(S.data.eth.getDefaultAddressBalance)
    return new BigNumber(ethBalanceR.getOrElse(0)).isGreaterThan(
      new BigNumber(fee)
    )
  }

  const calculateTo = destination => {
    if (!destination.type) {
      return { address: destination, type: ADDRESS_TYPES.ADDRESS }
    }

    return destination
  }

  const calculateSignature = function * (
    network,
    password,
    transport,
    scrambleKey,
    p
  ) {
    switch (p.raw.fromType) {
      case ADDRESS_TYPES.ACCOUNT: {
        let sign
        const appState = yield select(identity)
        const mnemonicT = S.wallet.getMnemonic(appState, password)
        const mnemonic = yield call(() => taskToPromise(mnemonicT))
        if (p.isErc20) {
          const contractAddress = (yield select(
            S.kvStore.eth.getErc20ContractAddr,
            toLower(p.coin)
          )).getOrFail('missing_contract_addr')
          sign = data =>
            taskToPromise(
              eth.signErc20(network, mnemonic, data, contractAddress)
            )
        } else {
          sign = data => taskToPromise(eth.sign(network, mnemonic, data))
        }
        return yield call(sign, p.raw)
      }
      case ADDRESS_TYPES.LOCKBOX: {
        return yield call(
          eth.signWithLockbox,
          network,
          transport,
          scrambleKey,
          p.raw
        )
      }
    }
  }

  const calculateUnconfirmed = function * (address: string) {
    const data: {
      transactions: Array<EthRawTxType>
    } = yield call(api.getEthTransactionsV2, address, 0, 1)

    if (
      data.transactions[0] &&
      data.transactions[0].state === 'PENDING' &&
      data.transactions[0].from === address
    )
      return true

    return false
  }

  function create({ network, payment } = { network: undefined, payment: {} }) {
    const makePayment = p => ({
      coin: 'ETH',

      value() {
        return p
      },

      * init({ coin, isErc20 }) {
        let contractAddress, fees
        try {
          if (isErc20) {
            contractAddress = (yield select(
              S.kvStore.eth.getErc20ContractAddr,
              toLower(coin)
            )).getOrFail('missing_contract_addr')
          }
          fees = yield call(api.getEthFees, contractAddress)
        } catch (e) {
          throw new Error(FETCH_FEES_FAILURE)
        }
        const gasPrice = prop('regular', fees)
        const gasLimit = isErc20
          ? prop('gasLimitContract', fees)
          : prop('gasLimit', fees)
        const fee = calculateFee(gasPrice, gasLimit, true)
        const isSufficientEthForErc20 = yield call(
          calculateIsSufficientEthForErc20,
          fee
        )

        return makePayment(
          mergeRight(p, {
            fees,
            fee,
            feeInGwei: gasPrice,
            isErc20,
            coin,
            isSufficientEthForErc20
          })
        )
      },

      to(destination) {
        let to = calculateTo(destination)
        if (!EthUtil.isValidAddress(to.address)) {
          throw new Error('Invalid address')
        }
        return makePayment(mergeRight(p, { to: to }))
      },

      amount(amount) {
        return makePayment(mergeRight(p, { amount }))
      },

      * from(origin, type: AddressTypesType, effectiveBalance?: string) {
        let from, unconfirmedTx

        if (type === 'CUSTODIAL') {
          from = {
            type,
            address: origin
          }
        } else {
          let account = origin
          if (isNil(origin) || origin === '') {
            const accountR = yield select(S.kvStore.eth.getDefaultAddress)
            account = accountR.getOrFail('missing_default_from')
          }
          const ethData = yield call(api.getEthBalances, account)
          const nonce = path([account, 'nonce'], ethData)
          let balance = p.isErc20
            ? (yield select(
                S.data.eth.getErc20Balance,
                toLower(p.coin)
              )).getOrFail('missing_erc20_balance')
            : path([account, 'balance'], ethData)

          effectiveBalance = calculateEffectiveBalance(
            balance,
            prop('fee', p),
            prop('isErc20', p)
          )
          from = {
            type: type || ADDRESS_TYPES.ACCOUNT,
            address: account,
            nonce
          }
          unconfirmedTx = yield call(calculateUnconfirmed, account)
        }

        return makePayment(
          mergeRight(p, { from, effectiveBalance, unconfirmedTx })
        )
      },

      * fee(value, origin) {
        let contract
        let account = origin
        if (origin === null || origin === undefined || origin === '') {
          const accountR = yield select(S.kvStore.eth.getDefaultAddress)
          account = accountR.getOrFail('missing_default_from')
        }
        if (p.from && p.from.type === 'CUSTODIAL') {
          return makePayment(
            mergeRight(p, {
              feeInGwei: 0,
              fee: 0
            })
          )
        }
        if (p.isErc20) {
          contract = (yield select(
            S.kvStore.eth.getErc20ContractAddr,
            toLower(p.coin)
          )).getOrFail('missing_contract_addr')
        }
        // value can be in gwei or string ('regular' or 'priority')
        const fees = prop('fees', p)
        const feeInGwei =
          indexOf(value, ['regular', 'priority']) > -1 ? fees[value] : value

        const gasLimit =
          p.isErc20 || p.isContract
            ? path(['fees', 'gasLimitContract'], p)
            : path(['fees', 'gasLimit'], p)
        const fee = calculateFee(feeInGwei, gasLimit as string, true)
        const isSufficientEthForErc20 = yield call(
          calculateIsSufficientEthForErc20,
          fee
        )

        const data = p.isErc20
          ? yield call(api.getErc20AccountSummaryV2, account, contract)
          : yield call(api.getEthBalances, account)

        const balancePath = p.isErc20
          ? path(['balance'])
          : path([account, 'balance'])

        const balance = balancePath(data)
        // balance + fee need to be in wei
        let effectiveBalance = calculateEffectiveBalance(
          balance,
          fee,
          p.isErc20
        )
        return makePayment(
          mergeRight(p, {
            feeInGwei,
            fee,
            effectiveBalance,
            isSufficientEthForErc20
          })
        )
      },

      * build() {
        const fromData = prop('from', p)
        const index = yield call(selectIndex, fromData)
        const to = path(['to', 'address'], p)
        const amount = prop('amount', p)
        const gasPrice = convertGweiToWei(prop('feeInGwei', p))
        const gasLimit =
          p.isErc20 || p.isContract
            ? path(['fees', 'gasLimitContract'], p)
            : path(['fees', 'gasLimit'], p)
        const nonce = prop('nonce', fromData)
        const from = prop('address', fromData)
        const fromType = prop('type', fromData)
        if (fromType === 'CUSTODIAL') return makePayment(p)
        if (isNil(from)) throw new Error('missing_from')
        if (!isValidIndex(index)) throw new Error('invalid_index')
        if (isNil(to)) throw new Error('missing_to')
        if (!isValidAddress(to)) throw new Error('invalid_to')
        if (isNil(amount)) throw new Error('missing_amount')
        if (isNil(gasPrice)) throw new Error('missing_gasprice')
        if (isNil(gasLimit)) throw new Error('missing_gaslimit')
        if (isNil(nonce)) throw new Error('missing_nonce')
        if (!isPositiveInteger(nonce)) throw new Error('invalid_nonce')
        const raw = {
          index,
          to,
          amount,
          gasPrice,
          gasLimit,
          nonce,
          from,
          fromType
        }
        return makePayment(mergeRight(p, { raw }))
      },

      * sign(password, transport, scrambleKey) {
        try {
          const signed = yield call(
            calculateSignature,
            network,
            password,
            transport,
            scrambleKey,
            p
          )
          return makePayment(mergeRight(p, { signed }))
        } catch (e) {
          if (e && e instanceof Error) {
            throw e
          } else {
            throw new Error('missing_mnemonic')
          }
        }
      },

      * signLegacy(password) {
        try {
          const appState = yield select(identity)
          const seedHexT = S.wallet.getSeedHex(appState, password)
          const seedHex = yield call(() => taskToPromise(seedHexT))
          const signLegacy = data =>
            taskToPromise(eth.signLegacy(network, seedHex, data))
          const signed = yield call(signLegacy, p.raw)
          return makePayment(mergeRight(p, { signed }))
        } catch (e) {
          throw new Error('missing_seed_hex')
        }
      },

      * publish() {
        const signed = prop('signed', p)
        if (isNil(signed)) throw new Error('missing_signed_tx')
        const publish = () => api.pushEthTx(signed).then(prop('txHash'))
        const txId = yield call(publish)
        yield call(settingsSagas.setLastTxTime)
        return makePayment(mergeRight(p, { txId }))
      },

      fees(fees) {
        return makePayment(mergeRight(p, { fees }))
      },

      setIsContract(isContract) {
        return makePayment(mergeRight(p, { isContract }))
      },

      setIsErc20(isErc20) {
        return makePayment(mergeRight(p, { isErc20 }))
      },

      setIsRetryAttempt(
        isRetryAttempt: boolean,
        nonce: string,
        minFeeRequiredForRetry: string
      ) {
        return makePayment(
          mergeRight(p, {
            from: { ...p.from, nonce: Number(nonce) },
            isRetryAttempt,
            minFeeRequiredForRetry
          })
        )
      },

      setCoin(coin) {
        return makePayment(mergeRight(p, { coin }))
      },

      description(message) {
        return isString(message)
          ? makePayment(mergeRight(p, { description: message }))
          : makePayment(p)
      },

      chain() {
        const chain = (gen, f) =>
          makeChain(function * () {
            return yield f(yield gen())
          })

        const makeChain = gen => ({
          init: values => chain(gen, payment => payment.init(values)),
          to: address => chain(gen, payment => payment.to(address)),
          amount: amount => chain(gen, payment => payment.amount(amount)),
          from: (origin, type) =>
            chain(gen, payment => payment.from(origin, type)),
          fee: value => chain(gen, payment => payment.fee(value)),
          fees: fees => chain(gen, payment => payment.fees(fees)),
          build: () => chain(gen, payment => payment.build()),
          sign: password => chain(gen, payment => payment.sign(password)),
          publish: () => chain(gen, payment => payment.publish()),
          setIsErc20: val => chain(gen, payment => payment.setIsErc20(val)),
          setIsContract: val =>
            chain(gen, payment => payment.setIsContract(val)),
          setIsRetryAttempt: val =>
            chain(gen, payment => payment.setIsRetryAttempt(val)),
          setCoin: coin => chain(gen, payment => payment.setCoin(coin)),
          description: message =>
            chain(gen, payment => payment.description(message)),
          * done() {
            return yield gen()
          }
        })

        return makeChain(function * () {
          return yield call(makePayment, p)
        })
      }
    })

    return makePayment(payment)
  }

  return {
    create: create
  }
}
