import { Config } from "@remotion/cli/config";

// Use the Chromium that is already installed instead of downloading another.
// Remove this line on a machine without /opt/pw-browsers.
Config.setBrowserExecutable("/opt/pw-browsers/chromium");
Config.setVideoImageFormat("jpeg");
Config.setJpegQuality(95);
Config.setCodec("h264");
Config.setCrf(16);
