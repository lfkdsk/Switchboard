const Module = require("node:module");

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === "./peer" && /[\\/]cli[\\/]index\.js$/.test(parent?.filename || "")) {
    return {
      cmdHistory(_context, options) {
        process.stdout.write("HISTORY_OPTS " + JSON.stringify(options) + "\n");
        return Promise.resolve();
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
