import { SupportedDatabaseTypes } from "../core/databaseConfig.js";
import { config as dotenvConfig } from "dotenv";
import { Config } from "../interface/config.js";
dotenvConfig();


export default {
    token: process.env.DISCORD_TOKEN || '',
    embedColor: "#06c2fb",
    defaultLanguage: "en",
    debugMode: true,
  //  allowedServers: ["1158846168957210635", "1399471603003428966"], // Example server IDs
    prefix: "!",
    developers: ["527826654660132890"],
    database: {
        type: SupportedDatabaseTypes.Sqlite,
        path: "./data/badge2.db",
    },


} as Config
