// Adds Firebase (for push notifications when Bolverse is closed) only if google-services.json is
// present in this folder, so the app builds fine without it. See the guide, "Push notifications".
const fs = require("fs");
const path = require("path");

module.exports = ({ config }) => {
  const file = path.join(__dirname, "google-services.json");
  if (fs.existsSync(file)) {
    config.android = { ...config.android, googleServicesFile: "./google-services.json" };
  }
  return config;
};
