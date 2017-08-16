"use strict";

const uuid = require("uuid");
const request = require("request");
const _intents = require("./Intents");
const DirectLine = require("./DirectLine").DirectLine;
const _UniversalBot = require("./_UniversalBot")._UniversalBot;
const BotStateProxy = require("./BotStateProxy").BotStateProxy;
const utils = require("./Util")

class SubBot {
  constructor(endpoint, appId, appPassword, intents, name, description, image) {
    this._endpoint = endpoint;
    this._appId = appId;
    this._appPassword = appPassword;
    this._intents = intents;
    this.name = name;
    this.description = description;
    this.image = image;
  }

  static fromJSON(json) {
    let creds = json.credentials;
    let intents = _intents.intentFactory(json.intents)
    return new SubBot(creds.endpoint, creds.appId, creds.appPassword, intents, json.name, json.description, json.image);
  }
  uid() {
    return this._appId;
  }
  intents(intentType) {
    if (intentType) {
      return this._intents.filter((i) => {
        return (i instanceof intentType);
      });
    }
    return this._intents;
  }
}

class ConversationMapper {
  constructor() {
    this._conversations = {};
  }

  create(convId, subId) {
    if (!(convId in this._conversations)) {
      this._conversations[convId] = {};
    }
    if (!(subId in this._conversations[convId])) {
      this._conversations[convId][subId] = uuid.v4();
    }
    return this._conversations[convId][subId];
  }

  reverseLookup(convId) {
    for (let cid in this._conversations) {
      for (let subId in this._conversations[cid]) {
        if (this._conversations[cid][subId] == convId) {
          return { convId: cid, subId: subId };
        }
      }
    }
    return null;
  }
}

class MasterBot extends _UniversalBot {

  constructor(connector, defaultDialog, libraryName) {
    super(connector, defaultDialog, libraryName);
    this._subs = {};
    this._builtins = [];
    this._appId = connector.settings.appId;
    this._appPassword = connector.settings.appPassword;
    this._tokens = {};
    this._defaultHandler = this._connector.listen().bind(this._connector);
    this._focus = {};
    this._conversationMapper = new ConversationMapper();
    this._lastRequestLog = "";
  }

  _requestLog(append) {
    // Accumulate a log of the most recent request
    this._lastRequestLog += append;
  }

  startServer(config) {

    super.startServer(config);
    this._serviceURL = `https://${config.WEBSITE_HOSTNAME}`;

    this._server.post('/api/subbots', this._postSubbots.bind(this));
    this._server.post('/api/messages', this._routeMessage.bind(this));

    this._botStateProxy = new BotStateProxy(this._server);

    this._server.post(
      ':originalChannel/v3/conversations/:conversationId/activities/:activityId',
      this._replyToActivity.bind(this)
    );

    this._allowSubbotRouting = config.ALLOW_SUBBOT_ROUTING;

    return this._server;
  }

  _isSubBotSwitchReply(req) {
    return req.body.inputHint !== "expectingInput" && req.body && req.body.channelData && req.body.channelData.isRoutingRequest;
  }

  _switchToSubbot(activityReq, conv) {
    console.info("Executing subbot to subbot routing");
    let subbotId = activityReq.body.channelData.subbotId;
    let sub = this._subs[subbotId];
    let subBotRequest = {};
    subBotRequest.body =
      {
        "type": "message",
        "id": activityReq.params.activityId,
        "channelId": activityReq.params.originalChannel,
        "timestamp": activityReq.body.localTimestamp,
        "from": {
          "id": activityReq.body.recipient.id,
          "name": activityReq.body.recipient.name
        },
        "conversation": {},
        "recipient": activityReq.body.from,
        "text": activityReq.body.channelData.message
      };
    subBotRequest.body.conversation.id = conv.convId;

    this._sendToSub(sub, subBotRequest);
  }

  _replyToActivity(req, res, next) {

    let oc = req.params.originalChannel;
    let uri = `https://${oc}.botframework.com/v3`;
    let conv = this._conversationMapper.reverseLookup(req.params.conversationId);
    if (conv) {

      if (this._allowSubbotRouting && this._isSubBotSwitchReply(req)) {
        //remove tracking of conversation as focus is lost from the bot
        delete this._focus[conv.convId];
        this._switchToSubbot(req, conv);
        res.end();
        return next();
      }

      uri += `/conversations/${conv.convId}/activities/${req.params.activityId}`

      var opts = { uri: uri, method: "POST", json: req.body };
      
      if (req.body.name === "debug" && req.body.type === "event") {
        console.warn("Debug event, will not alter focus")
      } else {
        if (req.body.type === "typing") {
          console.log(req.body.type)
          this._focus[conv.convId] = conv.subId;
        }
        else if (req.body.inputHint === "expectingInput") {
          this._focus[conv.convId] = conv.subId;
        }
        else {
          console.warn("Removing bot focus")
          delete this._focus[conv.convId];
        }
      }

      utils.authenticatedRequest(opts, this._appId, this._appPassword)
        .then((response) => {
          res.end(JSON.stringify(response.body));
          next();
        });
      return;
    }
    console.warn("Reply in unknown conversation");
  }

  addSubbot(json) {
    let sub = SubBot.fromJSON(json);
    this._subs[sub.uid()] = sub;
  }

  addBuiltin(builtin) {
    this._builtins = this._builtins.concat(_intents.intentFactory([builtin]));
  }

  _deleteSubbot(appId) {
    this._subs = this._subs.filter((s) => {
      if (s.credentials.type == "sharedCredentials") {
        return !(s.credentials.appId == appId);
      }
      return true;
    });
  }

  /*
    _postSubbots - REST handler for adding a new subbot
  */
  _postSubbots(req, res, next) {
    var json = req.body;
    if (json) {
      this.addSubbot(json);
    }
    res.end("done");
    next();
  }

  _sendToSub(sub, req) {
    return new Promise((resolve, reject) => {

      req.body.conversation.id = this._conversationMapper.create(req.body.conversation.id, sub.uid());
      req.body.serviceUrl = `${this._serviceURL}/${req.body.channelId}`;
      req.body.channelId = "emulator";

      let opts = {
        uri: sub._endpoint,
        method: 'POST',
        json: req.body,
      };

      utils.authenticatedRequest(opts, sub._appId, sub._appPassword)
        .then((response) => {
          resolve(response);
        });
    });
  }

  /*
    _tryBuiltins 
    Try to match the incoming request against any builtins. We don't need to worry about 
    intentType here since all builtins are handled by the defaultHandler
  */
  _tryBuiltins(req, res, next) {
    let tasks = [];
    this._builtins.forEach((builtin) => {
      tasks = tasks.concat(this._builtins.map((i) => { return i.score(req.body.text) }));
    });

    return new Promise((resolve, reject) => {
      if (tasks.length === 0) {
        resolve(false);
      }
      else {
        Promise.all(tasks)
          .then((results) => {
            var topIntent = results.reduce((prev, curr) => {
              return prev.score > curr.score ? prev : curr;
            });

            if (topIntent.score > 0) {
              if (topIntent.utterance) {
                // Keyword matches remove the 'ask X' part for us
                req.body.text = topIntent.utterance;
              }
              this._requestLog("builtin");
              this._defaultHandler(req, res, next);
              resolve(true);
            }
            else {
              resolve(false);
            }
          });
      }
    });
  }

  /*
    _tryRouteIntentType - Try to match the incoming request against intents of type: intentType
  */
  _tryRouteIntentType(req, res, next, intentType) {

    let tasks = [];

    for (let sub in this._subs) {
      let intents = this._subs[sub].intents(intentType);
      tasks = tasks.concat(intents.map(i => { return i.score(req.body.text, sub) }));
    }

    return new Promise((resolve, reject) => {
      if (tasks.length == 0) {
        resolve(false);
      }
      else {
        Promise.all(tasks)
          .then((results) => {
            var topIntent = results.reduce((prev, curr) => {
              return prev.score > curr.score ? prev : curr;
            });

            if (topIntent.score > 0) {
              if (topIntent.utterance) {
                // Keyword matches remove the 'ask X' part for us
                req.body.text = topIntent.utterance;
              }
              this._sendToSub(this._subs[topIntent.sub], req)
                .then((response) => {
                  if (response.statusCode >= 400) {
                    this._requestLog(" - Dep failure - " + response.statusCode);
                    console.warn("sendToSub:" + response.statusCode)
                  }
                });
              this._requestLog(" - Routed " + intentType.name);
              resolve(true);
              res.end();
              next();
            }
            else {
              resolve(false);
            }
          });
      }
    });
  }

  _isSlashCommand(utterance) {
    return utterance.startsWith("/");
  }

  _isMessageRequest(req) {
    return (req.body && req.body.type === "message" && req.body.text);
  }

  /* 
    routeMessage - All utterances initially arrive here
  */
  _routeMessage(req, res, next) {

    // Clear request log (debuginfo)
    this._lastRequestLog = "";

    // If no subs, not a message or is slash command always use default handler
    if (!Object.keys(this._subs).length || !this._isMessageRequest(req) || this._isSlashCommand(req.body.text)) {
      this._defaultHandler(req, res, next);
      return;
    }

    // If a sub has the focus then route towards that one
    if (req.body.conversation.id in this._focus) {
      this._requestLog(" - Focus routed");
      this._sendToSub(this._subs[this._focus[req.body.conversation.id]], req);
      res.end();
      next();
      return;
    }

    // Try handlers in strict order
    // DESIGN CHOICE: Changing handler order significantly affects behaviour
    this._tryBuiltins(req, res, next)
      .then((handled) => {
        return handled || this._tryRouteIntentType(req, res, next, _intents.KeywordIntent)
      })
      .then((handled) => {
        return handled || this._tryRouteIntentType(req, res, next, _intents.LUISIntent);
      })
      .then((handled) => {
        return handled || this._tryRouteIntentType(req, res, next, _intents.RegexIntent);
      })
      .then((handled) => {
        if (!handled) {
          //this.requestLog("Default Route");
          this._defaultHandler(req, res, next);
        }
      });
  }

  handleSlashCommand(session) {
    let command = session.message.text.split(" ")[0];
    switch (command.toLowerCase()) {

      case "/addbuiltin": {
        let builtin = session.message.text.substring(command.length); // Remove the /command
        builtin = JSON.parse(builtin);
        this.addBuiltin(builtin);
        session.send("done");
      }
        break;

      case "/deletebuiltins": {
        this._builtins = [];
        session.send("done");
      }
        break;

      case "/listbuiltins": {
        session.send("Listing builtins:");
        if (Object.keys(this._subs).length > 0) {
          this._builtins.forEach((builtin) => {
            session.send(JSON.stringify(builtin));
          });
        }
        else {
          session.send("No builtins registered");
        }
      }
        break;

      case "/addsub": {
        // add new sub, indexed by appID
        let sub = session.message.text.substring(command.length); // Remove the /command
        sub = sub.replace(/[\u201C\u201D]/g, '"'); // Replace smart quotes
        sub = JSON.parse(sub);
        this.addSubbot(sub);
        session.send("done");
      }
        break;

      case "/deletesub": {
        // Delete the sub identified by appId
        let appId = session.message.text.split(" ")[1];
        this._deleteSubbot(appId);
        session.send("done");
      }
        break;

      case "/deletesubs": {
        // Delete all subs
        this._subs = [];
        session.send("done");
      }
        break;

      case "/listsubs":
      case "/showsubs": {
        // TODO: Doesn't match 100% the config format
        session.send("Listing subs:");
        if (Object.keys(this._subs).length > 0) {
          for (let sub in this._subs) {
            session.send(JSON.stringify(this._subs[sub]));
          }
        }
        else {
          session.send("No subs registered");
        }
      }
        break;

      case '/log': {
        // Show the lastRequestLog (quick debugging tool)
        session.send(this._lastRequestLog);
      }
        break;

      case '/reloadsubs': {
        this._subs = [];
        let subbots = config.SUBBOTS;
        if (subbots) {
          if (typeof subbots === "string") {
            subbots = JSON.parse(subbots);
          }
          subbots.forEach((subbot) => {
            masterBot.addSubbot(subbot);
          });
        }
      }

      default: {
        session.send("Unrecognised slash command");
      }
    }
  }
}

module.exports = {
  UniversalMasterBot: MasterBot
}
