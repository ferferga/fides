import { spawnSync } from "child_process";
import * as files from './files.js';
import * as config from '../config/config.js';
import { curlWithRetry } from "./utils.js";
import path from "path";

/**
 * @description Up infrastructue from docker compose
 * @param url - Infrastructure repository
 * @param envFile - Path to environment file
 * @param file - Path to docker compose file
 */
export function deploy(url, envFile, file) {
    const directory = config.infrastructure.directory;
    if (!files.directoryExists(directory)) {
        spawnSync("git", ["clone", url, directory], { stdio: "inherit" });
        console.log(`Repository cloned in ${directory}`);
    }

    files.copy(envFile, path.join(directory, '.env'));
    spawnSync("docker", ["compose", "-f", path.join(directory, file), "--env-file", path.join(directory, '.env'), "up", "-d", "--wait"], { stdio: "inherit" });
    console.log("Infrastructure up");
}

/**
 * @description Configure infrastructure for the agreement
 * @param agreement - Path to agreement file
 */
export function configure(agreement) {
    const agreementCopyPath = config.infrastructure.agreement.path.to;
    files.copy(agreement, agreementCopyPath);

    let rawdata = files.readFile(path.join(agreementCopyPath, files.getFileName(agreement)));
    let agreementData = JSON.parse(rawdata);
    let agreementName = agreementData.id.split('_')[0];
    const targetFile = config.infrastructure.agreement.path.prometheus;
    const targetData = [
        {
            "targets": [`exporter.${agreementName}.governify.io`],
            "labels": {
                "__metrics_path__": "/metrics",
                "monitoring": agreementName
            }
        }
    ]
    files.writeFile(targetFile, JSON.stringify(targetData, null, 2));
    console.log('Infrastructure configured');
}

/**
 * @description Load infrastructure data
 */
export function loadData() {
    console.log('Start load data');
    let dumpPath = config.infrastructure.dump;

    files.mkdir(dumpPath.backup);
    files.mkdir(path.join(dumpPath.backup, dumpPath.mongo.directory));
    files.mkdir(path.join(dumpPath.backup, dumpPath.influx.directory));

    const rawDeps = curlWithRetry(['http://127.0.0.1:5200/api/v1/public/database/dbRestore.js']);
    let dbStore = rawDeps.stdout;
    // Load Mongo dump
    files.copy(dumpPath.mongo.from, dumpPath.mongo.to);
    const mongoConfig = {
        "scriptText": dbStore.toString(),
        "scriptConfig": {
            "dbName": 'mongo-registry',
            "dbUrl": 'mongodb://falcon-mongo-registry',
            "dbType": 'Mongo',
            "backup": dumpPath.mongo.file
        }
    }
    curlWithRetry([dumpPath.assets.restoreTask, '-H', 'Content-Type: application/json','--data', JSON.stringify(mongoConfig)]);
    // Load Influx dump
    files.copy(dumpPath.influx.from, dumpPath.influx.to);
    const influxConfig = {
        "scriptText": dbStore.toString(),
        "scriptConfig": {
            "dbName": 'influx-reporter',
            "dbUrl": 'http://falcon-influx-reporter:8086',
            "dbType": 'Influx',
            "backup": dumpPath.influx.file
        }
    }
    curlWithRetry([dumpPath.assets.restoreTask, '-H', 'Content-Type: application/json', '--data', JSON.stringify(influxConfig)]);

    const dockerConfig = config.infrastructure.docker;
    const container_network = spawnSync("docker", ["inspect",
        "--format='{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}'",
        dockerConfig.mongoContainer
    ]).stdout.toString().replace(/'/g, "").trim();
    spawnSync("docker", ["run", "--name", dockerConfig.governifyState.container, "-d",
        "-e", `MONGO_URL=mongodb://${dockerConfig.mongoContainer}`,
        "--network", container_network,
        "-p", dockerConfig.governifyState.port,
        dockerConfig.governifyState.image], { stdio: "inherit" });
    console.log('Finish load data');
}

/**
 * @description Down infrastructure from docker compose
 * @param file - Path to docker compose file
 */
export function down(file) {
    const directory = config.infrastructure.directory;
    spawnSync("docker", ["compose", "-f", path.join(directory, file), "--env-file", path.join(directory, '.env'), "down", "--rmi", "all", "-v"], { stdio: "inherit" });
    spawnSync("docker", ["stop", config.infrastructure.docker.governifyState.container]);
    spawnSync("docker", ["rm", config.infrastructure.docker.governifyState.container]);
}
