// Expo SDK 52+ detects npm workspaces automatically, so @bolverse/shared resolves from the repo root. 
const { getDefaultConfig } = require('expo/metro-config');  
module.exports = getDefaultConfig(__dirname); 
