let async = require('async');
//require("../utils/debug_util.js")(__filename, async);
let utils = require('../../utils/utils.js');
import { ZERO_ADDRESS } from '../../utils/addressUtils';

class ContractDeployer {
  constructor(options) {
    const self = this;
    this.logger = options.logger;
    this.events = options.events;
    this.plugins = options.plugins;

    self.events.setCommandHandler('deploy:contract', (contract, cb) => {
      self.checkAndDeployContract(contract, null, cb);
    });
  }

  // TODO: determining the arguments could also be in a module since it's not
  // part of a 'normal' contract deployment
  determineArguments(suppliedArgs, contract, accounts, callback) {
    const self = this;

    let args = suppliedArgs;
    if (!Array.isArray(args)) {
      args = [];
      let abi = contract.abiDefinition.find((abi) => abi.type === 'constructor');

      for (let input of abi.inputs) {
        let inputValue = suppliedArgs[input.name];
        if (!inputValue) {
          this.logger.error(__("{{inputName}} has not been defined for {{className}} constructor", {inputName: input.name, className: contract.className}));
        }
        args.push(inputValue || "");
      }
    }

    function parseArg(arg, cb) {
      const match = arg.match(/\$accounts\[([0-9]+)]/);
      if (match) {
        if (!accounts[match[1]]) {
          return cb(__('No corresponding account at index %d', match[1]));
        }
        return cb(null, accounts[match[1]]);
      }
      let contractName = arg.substr(1);
      self.events.request('contracts:contract', contractName, (referedContract) => {
        // Because we're referring to a contract that is not being deployed (ie. an interface),
        // we still need to provide a valid address so that the ABI checker won't fail.
        cb(null, (referedContract.deployedAddress || ZERO_ADDRESS));
      });
    }

    async.map(args, (arg, nextEachCb) => {
      if (arg[0] === "$") {
        parseArg(arg, nextEachCb);
      } else if (Array.isArray(arg)) {
        async.map(arg, (sub_arg, nextSubEachCb) => {
          if (sub_arg[0] === "$") {
            parseArg(sub_arg, nextSubEachCb);
          } else if(typeof sub_arg === 'string' && sub_arg.indexOf('.eth') === sub_arg.length - 4) {
            self.events.request("ens:resolve", sub_arg, (err, name) => {
              if(err) {
                return nextSubEachCb(err);
              }
              return nextSubEachCb(err, name);
            });
          } else {
            nextSubEachCb(null, sub_arg);
          }
        }, (err, subRealArgs) => {
          nextEachCb(null, subRealArgs);
        });
      } else if(typeof arg === 'string' && arg.indexOf('.eth') === arg.length - 4) {
        self.events.request("ens:resolve", arg, (err, name) => {
          if(err) {
            return nextEachCb(err);
          }
          return nextEachCb(err, name);
        });
      } else {
        nextEachCb(null, arg);
      }
    }, callback);
  }

  checkAndDeployContract(contract, params, callback) {
    let self = this;
    contract.error = false;
    let accounts = [];
    let deploymentAccount;

    if (contract.deploy === false) {
      self.events.emit("deploy:contract:undeployed", contract);
      return callback();
    }

    async.waterfall([
      function requestBlockchainConnector(callback) {
        self.events.request("blockchain:object", (blockchain) => {
          self.blockchain = blockchain;
          callback();
        });
      },

      // TODO: can potentially go to a beforeDeploy plugin
      function getAccounts(next) {
        deploymentAccount = self.blockchain.defaultAccount();
        self.blockchain.getAccounts(function (err, _accounts) {
          if (err) {
            return next(new Error(err));
          }
          accounts = _accounts;

          // applying deployer account configuration, if any
          if (typeof contract.fromIndex === 'number') {
            deploymentAccount = accounts[contract.fromIndex];
            if (deploymentAccount === undefined) {
              return next(__("error deploying") + " " + contract.className + ": " + __("no account found at index") + " " + contract.fromIndex + __(" check the config"));
            }
          }
          if (typeof contract.from === 'string' && typeof contract.fromIndex !== 'undefined') {
            self.logger.warn(__('Both "from" and "fromIndex" are defined for contract') + ' "' + contract.className + '". ' + __('Using "from" as deployer account.'));
          }
          if (typeof contract.from === 'string') {
            deploymentAccount = contract.from;
          }

          deploymentAccount = deploymentAccount || accounts[0];
          contract.deploymentAccount = deploymentAccount;
          next();
        });
      },
      function applyArgumentPlugins(next) {
        self.plugins.emitAndRunActionsForEvent('deploy:contract:arguments', {contract: contract}, (_params) => {
          next();
        });
      },
      function _determineArguments(next) {
        self.determineArguments(params || contract.args, contract, accounts, (err, realArgs) => {
          if (err) {
            return next(err);
          }
          contract.realArgs = realArgs;
          next();
        });
      },
      function deployIt(next) {
        let skipBytecodeCheck = false;
        if (contract.address !== undefined) {
          try {
            utils.toChecksumAddress(contract.address);
          } catch(e) {
            self.logger.error(__("error deploying %s", contract.className));
            self.logger.error(e.message);
            contract.error = e.message;
            self.events.emit("deploy:contract:error", contract);
            return next(e.message);
          }
          contract.deployedAddress = contract.address;
          skipBytecodeCheck = true;
        }

        self.plugins.emitAndRunActionsForEvent('deploy:contract:shouldDeploy', {contract: contract, shouldDeploy: true}, function(_err, params) {
          let trackedContract = params.contract;
          if (!params.shouldDeploy) {
            return self.willNotDeployContract(contract, trackedContract, next);
          }
          if (!trackedContract.address) {
            return self.deployContract(contract, next);
          }
          // deploy the contract regardless if track field is defined and set to false
          if (trackedContract.track === false) {
            self.logFunction(contract)(contract.className.bold.cyan + __(" will be redeployed").green);
            return self.deployContract(contract, next);
          }

          self.blockchain.getCode(trackedContract.address, function(_getCodeErr, codeInChain) {
            if (codeInChain.length > 3 || skipBytecodeCheck) { // it is "0x" or "0x0" for empty code, depending on web3 version
              self.contractAlreadyDeployed(contract, trackedContract, next);
            } else {
              self.deployContract(contract, next);
            }
          });
        });
      }
    ], callback);
  }

  willNotDeployContract(contract, trackedContract, callback) {
    contract.deploy = false;
    this.events.emit("deploy:contract:undeployed", contract);
    callback();
  }

  contractAlreadyDeployed(contract, trackedContract, callback) {
    const self = this;
    this.logFunction(contract)(contract.className.bold.cyan + __(" already deployed at ").green + trackedContract.address.bold.cyan);
    contract.deployedAddress = trackedContract.address;
    self.events.emit("deploy:contract:deployed", contract);

    // TODO: can be moved into a afterDeploy event
    // just need to figure out the gasLimit coupling issue
    self.events.request('code-generator:contract:vanilla', contract, contract._gasLimit || false, (contractCode) => {
      self.events.request('runcode:eval', contractCode, () => {}, true);
      return callback();
    });
  }

  logFunction(contract) {
    return contract.silent ? this.logger.trace.bind(this.logger) : this.logger.info.bind(this.logger);
  }

  deployContract(contract, callback) {
    let self = this;
    let deployObject;

    async.waterfall([
      function doLinking(next) {
        let contractCode = contract.code;
        self.events.request('contracts:list', (_err, contracts) => {
          for (let contractObj of contracts) {
            let filename = contractObj.filename;
            let deployedAddress = contractObj.deployedAddress;
            if (deployedAddress) {
              deployedAddress = deployedAddress.substr(2);
            }
            let linkReference = '__' + filename + ":" + contractObj.className;
            if (contractCode.indexOf(linkReference.substr(0, 38)) < 0) { // substr to simulate the cut that solc does
              continue;
            }
            if (linkReference.length > 40) {
              return next(new Error(__("{{linkReference}} is too long, try reducing the path of the contract ({{filename}}) and/or its name {{contractName}}", {linkReference: linkReference, filename: filename, contractName: contractObj.className})));
            }
            let toReplace = linkReference + "_".repeat(40 - linkReference.length);
            if (deployedAddress === undefined) {
              let libraryName = contractObj.className;
              return next(new Error(__("{{contractName}} needs {{libraryName}} but an address was not found, did you deploy it or configured an address?", {contractName: contract.className, libraryName: libraryName})));
            }
            contractCode = contractCode.replace(new RegExp(toReplace, "g"), deployedAddress);
          }
          // saving code changes back to the contract object
          contract.code = contractCode;
          self.events.request('contracts:setBytecode', contract.className, contractCode);
          next();
        });
      },
      function applyBeforeDeploy(next) {
        self.plugins.emitAndRunActionsForEvent('deploy:contract:beforeDeploy', {contract: contract}, (_params) => {
          next();
        });
      },
      function getGasPriceForNetwork(next) {
        self.events.request("blockchain:gasPrice", (err, gasPrice) => {
          if (err) {
            return next(new Error(__("could not get the gas price")));
          }
          contract.gasPrice = contract.gasPrice || gasPrice;
          next();
        });
      },
      function createDeployObject(next) {
        let contractCode   = contract.code;
        let contractObject = self.blockchain.ContractObject({abi: contract.abiDefinition});
        let contractParams = (contract.realArgs || contract.args).slice();

        try {
          const dataCode = contractCode.startsWith('0x') ? contractCode : "0x" + contractCode;
          deployObject = self.blockchain.deployContractObject(contractObject, {arguments: contractParams, data: dataCode});
        } catch(e) {
          if (e.message.indexOf('Invalid number of parameters for "undefined"') >= 0) {
            return next(new Error(__("attempted to deploy %s without specifying parameters", contract.className)) + ". " + __("check if there are any params defined for this contract in this environment in the contracts configuration file"));
          }
          return next(new Error(e));
        }
        next();
      },
      function estimateCorrectGas(next) {
        if (contract.gas === 'auto') {
          return self.blockchain.estimateDeployContractGas(deployObject, (err, gasValue) => {
            if (err) {
              return next(err);
            }
            let increase_per = 1 + (Math.random() / 10.0);
            contract.gas = Math.floor(gasValue * increase_per);
            next();
          });
        }
        next();
      },
      function deployTheContract(next) {
        let estimatedCost = contract.gas * contract.gasPrice;
        self.logFunction(contract)(__("deploying") + " " + contract.className.bold.cyan + " " + __("with").green + " " + contract.gas + " " + __("gas at the price of").green + " " + contract.gasPrice + " " + __("Wei, estimated cost:").green + " " + estimatedCost + " Wei".green);

        self.blockchain.deployContractFromObject(deployObject, {
          from: contract.deploymentAccount,
          gas: contract.gas,
          gasPrice: contract.gasPrice
        }, function(error, receipt) {
          if (error) {
            contract.error = error.message;
            self.events.emit("deploy:contract:error", contract);
            if (error.message && error.message.indexOf('replacement transaction underpriced') !== -1) {
              self.logger.warn("replacement transaction underpriced: This warning typically means a transaction exactly like this one is still pending on the blockchain");
            }
            return next(new Error("error deploying =" + contract.className + "= due to error: " + error.message));
          }
          self.logFunction(contract)(`${contract.className.bold.cyan} ${__('deployed at').green} ${receipt.contractAddress.bold.cyan} ${__("using").green} ${receipt.gasUsed} ${__("gas").green} (txHash: ${receipt.transactionHash.bold.cyan})`);
          contract.deployedAddress = receipt.contractAddress;
          contract.transactionHash = receipt.transactionHash;
          receipt.className = contract.className;
          self.events.emit("deploy:contract:receipt", receipt);
          self.events.emit("deploy:contract:deployed", contract);

          // TODO: can be moved into a afterDeploy event
          // just need to figure out the gasLimit coupling issue
          self.events.request('code-generator:contract:vanilla', contract, contract._gasLimit || false, (contractCode) => {
            self.events.request('runcode:eval', contractCode, () => {}, true);
            self.plugins.runActionsForEvent('deploy:contract:deployed', {contract: contract}, () => {
              return next(null, receipt);
            });
          });
        });
      }
    ], callback);
  }

}

module.exports = ContractDeployer;
