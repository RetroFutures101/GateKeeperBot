const { Bot, session, GrammyError, HttpError } = require('grammy');

// Initialize Telegram bot
const botToken = process.env.TELEGRAM_BOT_TOKEN || '';
const bot = new Bot(botToken);

// Define session interface
bot.use(
  session({
    initial: () => ({
      captcha: "",
      attempts: 0,
    }),
  })
);

// Generate a random 6-digit alphanumerical captcha
function generateCaptcha() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "";
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Add the attribution footer to messages
function addAttribution(message) {
  return `${message}\n\n[created for you by POWERCITY.io](https://powercity.io)`;
}

module.exports = {
  bot,
  generateCaptcha,
  addAttribution,
  GrammyError,
  HttpError
};
