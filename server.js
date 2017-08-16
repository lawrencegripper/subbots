const nconf = require("nconf");
const request = require("request");
const botbuilder = require("botbuilder");
const appInsights = require("applicationinsights");
const MasterBot = require("./lib/MasterBot").UniversalMasterBot;

function main() {

  console.log("mainBot: starting...");
  var config = nconf.env().argv().file({ file: 'localConfig.json', search: true }).get();

  if (config.APP_INSIGHTS_KEY) {
    appInsights.setup(config.APP_INSIGHTS_KEY);
    appInsights.start();
  }

  var masterBot = new MasterBot(new botbuilder.ChatConnector({
    appId: config.MICROSOFT_APP_ID,
    appPassword: config.MICROSOFT_APP_PASSWORD
  }));

  masterBot.startServer(config);
  masterBot._server.get("/public/webchat", (req, res, next) => {
    let html = `<html><head><title>IPA MainBot</title></head><body>
    <p align="center">
    <iframe width=800 height=600 src='https://webchat.botframework.com/embed/${config.BOT_HANDLE}?s=${config.WEBCHAT_SECRET}'></iframe>
    </p>
    </body></html>`;
    res.end(html);
    next();
  });

  let introMessage = config.INTRO_MESSAGE || "INSERT INTRO TEXT HERE";
  let errorMessage = config.ERROR_MESSAGE || "I'm sorry, I don't know how to handle that request";

  masterBot.dialog("/",
    (session, args) => {
      if (!session.message.text || session.message.text.length === 0) {
        session.send(errorMessage);
      }
      else {
        if (session.message.text.startsWith("/")) {
          masterBot.handleSlashCommand(session);
        }
        else if (session.message.text.toLowerCase().startsWith("explain assistant")) {
          session.send(introMessage);
        }
      }
    }
  );

  let welcomeMessage = config.WELCOME_MESSAGE || "Welcome to the Master Bot";
  masterBot.on("conversationUpdate", (activity) => {
    if (activity.source === "webchat") {
      masterBot.send(new botbuilder.Message().address(activity.address).text(welcomeMessage));
    }

    if (activity.membersAdded.filter(x => x.id === activity.address.user.id).length > 0) {
      let subbotCards = []
      let message = new botbuilder.Message().address(activity.address)
      Object.keys(masterBot._subs).forEach(sub => {
        subbotCards.push(new botbuilder.HeroCard()
          .title(sub.name)
          .text(sub.description)
          .images([new botbuilder.CardImage().url('https://patient.azureedge.net/gfx/interim-patient-logo.svg')])
          .buttons([
            botbuilder.CardAction.imBack(null, "I'd like to check my symtoms", "Start chatting")
          ]))
      })
      message.attachmentLayout(botbuilder.AttachmentLayout.carousel)
      message.attachments(subbotCards)
      masterBot.send(message)
    }
  });

  // Load up any builtins. Builtins are always handled by the defaultHandler except when
  // a subbot has the focus
  let builtins = config.BUILTINS;
  if (builtins) {
    if (typeof builtins === "string") {
      builtins = JSON.parse(builtins);
    }
    builtins.forEach((builtin) => {
      masterBot.addBuiltin(builtin);
    })
  }

  // Load up the starting subbots
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

main();
