const fs = require('../../core/fs.js');
const ProcessWrapper = require('../../core/processes/processWrapper');
const BlockchainClient = require('./blockchain');
const i18n = require('../../core/i18n/i18n.js');
const constants = require('../../constants');

let blockchainProcess;

class BlockchainProcess extends ProcessWrapper {
  constructor(options) {
    // console.log("BEFORE SUPERRR");
    options.name = "GETHHH";
    super(options);
    // console.log("After Superrr");
    this.blockchainConfig = options.blockchainConfig;
    this.client = options.client;
    this.env = options.env;
    this.isDev = options.isDev;
    this.ssl = {
      enabled: options.embark.config.webServerConfig.https
    };
    console.log("New Blockchain Process");
    try {
      this.ssl.key = fs.readFileSync(options.embark.config.webServerConfig.key);
      this.ssl.cert = fs.readFileSync(options.embark.config.webServerConfig.cert);
      console.log("Using geth proxy");
    } catch (e) {
      // Can't Use geth proxy
      console.log("Cannot use geth proxy");
      this.ssl.enabled = false;
    }
    i18n.setOrDetectLocale(options.locale);

    this.blockchainConfig.silent = true;
    this.blockchain = BlockchainClient(
      this.blockchainConfig,
      this.client,
      this.env,
      this.ssl,
      this.blockchainReady.bind(this),
      this.blockchainExit.bind(this),
      console
    );

    this.blockchain.run();
  }

  blockchainReady() {
    blockchainProcess.send({result: constants.blockchain.blockchainReady});
  }

  blockchainExit() {
    // tell our parent process that ethereum client has exited
    blockchainProcess.send({result: constants.blockchain.blockchainExit});
  }

  kill() {
    this.blockchain.kill();
  }
}

process.on('message', (msg) => {
  if (msg === 'exit') {
    return blockchainProcess.kill();
  }
  console.log("New Message");
  if (msg.action === constants.blockchain.init) {
    console.log("MESSAGE: INIT");
    blockchainProcess = new BlockchainProcess(msg.options);
    return blockchainProcess.send({result: constants.blockchain.initiated});
  }
});
