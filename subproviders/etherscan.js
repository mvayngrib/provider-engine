/*
 * Etherscan.io API connector
 * @author github.com/axic
 *
 * The etherscan.io API supports:
 *
 * 1) Natively via proxy methods
 * - eth_blockNumber *
 * - eth_getBlockByNumber *
 * - eth_getBlockTransactionCountByNumber
 * - getTransactionByHash
 * - getTransactionByBlockNumberAndIndex
 * - eth_getTransactionCount *
 * - eth_sendRawTransaction *
 * - eth_call *
 * - eth_getTransactionReceipt *
 * - eth_getCode *
 * - eth_getStorageAt *
 *
 * 2) Via non-native methods
 * - eth_getBalance
 * - eth_listTransactions (non-standard)
 */

const xhr = process.browser ? require('xhr') : require('request')
const inherits = require('util').inherits
const extend = require('xtend')
const Subprovider = require('./subprovider.js')
const LIST_TX_PROPS = [
  'address',
  'startblock',
  'endblock',
  'sort',
  'page',
  'offset'
]

module.exports = EtherscanProvider

inherits(EtherscanProvider, Subprovider)

function EtherscanProvider(opts) {
  opts = opts || {}
  this.network = opts.network || 'api'
  this.apiKey = opts.apiKey
  this.proto = (opts.https || false) ? 'https' : 'http'
  this.requests = [];
  this.times = isNaN(opts.times) ? 4 : opts.times;
  this.interval = isNaN(opts.interval) ? 1000 : opts.interval;
  this.retryFailed = typeof opts.retryFailed === 'boolean' ? opts.retryFailed : true; // not built yet
}

EtherscanProvider.prototype.handleRequests = function(){
	if(this.requests.length == 0) return;

	//console.log('Handling the next ' + this.times + ' of ' + this.requests.length + ' requests');

	for(var requestIndex = 0; requestIndex < this.times; requestIndex++) {
		var requestItem = this.requests.shift()

		if(typeof requestItem !== 'undefined')
			handlePayload(requestItem)
	}
}

EtherscanProvider.prototype.stop = function () {
  clearInterval(this._interval)
}

EtherscanProvider.prototype.start = function () {
  // avoid scheduling multiple intervals
  this.stop()
  this._interval = setInterval(this.handleRequests.bind(this), this.interval)
}

EtherscanProvider.prototype.handleRequest = function(payload, next, end){
  var requestObject = {
      proto: this.proto,
      network: this.network,
      payload: payload,
      next: next,
      end: normalizeCallback(end),
      apiKey: this.apiKey
    },
	  self = this;

  if(this.retryFailed)
	  requestObject.end = function(err, result){
		  if(err === '403 - Forbidden: Access is denied.')
			 self.requests.push(requestObject);
		  else
			 end(err, result);
		  };

  this.requests.push(requestObject);
}

function handlePayload(opts){
  opts = extend(opts)
  const { payload, next, network, apiKey } = opts

  // defaults
  let proto = opts.proto
  let method = 'GET'
  let module = 'proxy'
  let params = {}
  let action = payload.method
  let end = opts.end

  const params0 = payload.params[0]

  switch(payload.method) {
    case 'eth_blockNumber':
      break
    case 'eth_getBlockByNumber':
      params = {
        tag: payload.params[0],
        boolean: payload.params[1]
      }
      break

    case 'eth_getBlockTransactionCountByNumber':
      params = {
        tag: payload.params[0]
      }
      break

    case 'eth_getTransactionByHash':
      params = {
        txhash: payload.params[0]
      }
      break

    case 'eth_getBalance':
      module = 'account'
      action = 'balance'
      params = {
        address: payload.params[0],
        tag: payload.params[1]
      }
      break

    case 'eth_listTransactions':
      for (let i = 0, l = Math.min(payload.params.length, LIST_TX_PROPS.length); i < l; i++) {
        params[LIST_TX_PROPS[i]] = payload.params[i]
      }

      module = 'account'
      action = 'txlist'
      break

    case 'eth_call':
      params = payload.params[0]
      break

    case 'eth_sendRawTransaction':
      method = 'POST'
      params = { hex: payload.params[0] }
      break

    case 'eth_getTransactionReceipt':
      params = { txhash: payload.params[0] }
      break

    // note !! this does not support topic filtering yet, it will return all block logs
    case 'eth_getLogs':
      var payloadObject = payload.params[0],
          txProcessed = 0,
          logs = [];

      action = 'eth_getBlockByNumber'
      params = {
        tag: payloadObject.toBlock,
        boolean: payload.params[1]
      }

      end = function(err, blockResult) {
        const originalEnd = opts.end
        if(err) return originalEnd(err);

        blockResult.transactions.forEach(function (transaction) {
          etherscanXHR({
            method: 'GET',
            proto: proto,
            network: network,
            module: 'proxy',
            action: 'eth_getTransactionReceipt',
            params: { txhash: transaction.hash },
          }, function(err, receiptResult) {
            if(!err) logs.concat(receiptResult.logs);
            txProcessed += 1;
            if(txProcessed === blockResult.transactions.length) originalEnd(null, logs)
          })
        })
      }

      break

    case 'eth_getTransactionCount':
      params = {
        address: payload.params[0],
        tag: payload.params[1]
      }
      break

    case 'eth_getCode':
      params = {
        address: payload.params[0],
        tag: payload.params[1]
      }
      break

    case 'eth_getStorageAt':
      params = {
        address: payload.params[0],
        position: payload.params[1],
        tag: payload.params[2]
      }
      break
    case 'eth_estimateGas':
      params = pickNonNull({
        to: params0.to,
        value: params0.value,
        gasPrice: params0.gasPrice,
        gas: params0.gas
      })
      break

    default:
      next();
      return
  }

  etherscanXHR({
    method: method,
    proto: proto,
    network: network,
    apiKey: apiKey,
    module: module,
    action: action,
    params: params
  }, end)
}

function toQueryString(params) {
  return Object.keys(params).map(function(k) {
    return encodeURIComponent(k) + '=' + encodeURIComponent(params[k])
  }).join('&')
}

function etherscanXHR({ method, proto, network, apiKey, module, action, params }, end) {
  var uri = proto + '://api-' + network + '.etherscan.io/api?' + toQueryString({ module: module, action: action }) + '&' + toQueryString(params)
  if (apiKey) uri += '&' + toQueryString({ apikey: apiKey })

  xhr({
    uri: uri,
    method: method,
    headers: {
      'Accept': 'application/json',
      // 'Content-Type': 'application/json',
    },
    rejectUnauthorized: false,
  }, function(err, res, body) {
    // console.log('[etherscan] response: ', err)

    if (err) return end(err)

    if(body.indexOf('403 - Forbidden: Access is denied.') > -1)
       return end('403 - Forbidden: Access is denied.')

    if (res.statusCode > 300)
      return end(res.statusMessage || body)

	  /*console.log('[etherscan request]'
				  + ' method: ' + useGetMethod
				  + ' proto: ' + proto
				  + ' network: ' + network
				  + ' module: ' + module
				  + ' action: ' + action
				  + ' params: ' + params
				  + ' return body: ' + body);*/

    var data
    try {
      data = JSON.parse(body)
    } catch (err) {
      console.error(err.stack)
      return end(err)
    }

    // console.log('[etherscan] response decoded: ', data)

    // NOTE: or use id === -1? (id=1 is 'success')
    if ((module === 'proxy') && data.error) {
      // Maybe send back the code too?
      return end(data.error.message)
    }

    // NOTE: or data.status !== 1?
    if ((module === 'account') && (data.message !== 'OK')) {
      return end(data.message)
    }

    end(null, data.result)
  })
}

function pickNonNull (obj) {
  const defined = {}
  for (let key in obj) {
    if (obj[key] != null) {
      defined[key] = obj[key]
    }
  }

  return defined
}

function normalizeError (err) {
  if (err instanceof Error) return err

  return new Error("" + err)
}

function normalizeCallback (cb) {
  return function (err, result) {
    if (err) err = normalizeError(err)

    cb(err, result)
  }
}
