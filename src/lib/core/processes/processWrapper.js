process.on('uncaughtException', function(e) {
  process.send({error: e.stack});
});

const constants = require('../../constants');
const Events = require('./eventsWrapper');

class ProcessWrapper {

  /**
   * Class from which process extend. Should not be instantiated alone.
   * Manages the log interception so that all console.* get sent back to the parent process
   * Also creates an Events instance. To use it, just do `this.events.[on|request]`
   *
   * @param {Options}     options    pingParent: true by default
   */
  constructor(options = {}) {
    // console.log("Before assigninggg " + options.name);
    this.options = Object.assign({pingParent: true}, options);
    // console.log("Before logggg " + options.name);
    this.interceptLogs();
    console.log("Before new eventssss " + options.name);
    this.events = new Events();
    console.log("Before Ping " + options.name);
    if(this.options.pingParent) {
    console.log("Before Ping inside IFF");
      this.pingParent();
    }
    console.log("After Print Parent");
  }

  // Ping parent to see if it is still alive. Otherwise, let's die
  pingParent() {
    const self = this;
    self.retries = 0;
    function error() {
      if (self.retries > 2) {
          self.kill();
          process.exit();
      }
      self.retries++;
    }
    setInterval(() => {
      try {
        let result = self.send({action: 'ping'});
        if (!result) {
          return error();
        }
        self.retries = 0;
      } catch (e) {
        error();
      }
    }, 500);
  }

  interceptLogs() {
    const context = {};
    context.console = console;
    console.log("STARTSSS interceptinggggg " + this.options.name);
    context.console.log = this._log.bind(this, 'log');
    console.log("After interceptinggggg LOGSSSS" + this.options.name);

    context.console.warn = this._log.bind(this, 'warn');
    context.console.error = this._log.bind(this, 'error');
    context.console.info = this._log.bind(this, 'info');
    context.console.debug = this._log.bind(this, 'debug');
    context.console.trace = this._log.bind(this, 'trace');
    context.console.dir = this._log.bind(this, 'dir');
    console.log("ENDSS interceptinggggg" + this.options.name);

  }

  _log(type, ...messages) {
    const isHardSource = messages.some(message => {
      return (typeof message === 'string' && message.indexOf('hardsource') > -1);
    });
    if (isHardSource) {
      return;
    }
    this.send({result: constants.process.log, message: messages, type});
  }

  send() {
    if (!process.connected) {
      return false;
    }
    return process.send(...arguments);
  }

  kill() {
    // Should be implemented by derived class
    console.log('Process killed');
  }
}

process.on('exit', () => {
  process.exit(0);
});

module.exports = ProcessWrapper;
