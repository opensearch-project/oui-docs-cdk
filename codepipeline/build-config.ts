import * as cdk from "aws-cdk-lib";

// These values map to the keys in our cdk.json and make sure
// no values that aren't supported are passed in with the
// -c config=env flag
const supportedEnvironments = ["prod", "dev"] as const;

type SupportedEnvironments = typeof supportedEnvironments[number];

// This maps to the values you specified in your cdk.json file
// if you add any values to your cdk.json file, also add them here!
export type BuildConfig = {
    environment: SupportedEnvironments;
    appPrefix: string;
    region: string;
};

// This function is used by your CDK app and pulls your config values
// from the context
export const getConfig = (app: cdk.App): BuildConfig => {
    const env = app.node.tryGetContext("config");
    if (!env) {
        throw new Error(
            "Environment variable must be passed to cdk: `yarn cdk -c config=XXX`"
        );
    }
    if (!supportedEnvironments.includes(env)) {
        throw new Error(
            `${env} is not in supported environments: ${supportedEnvironments.join(
                ", "
            )}`
        );
    }
    // this contains the values in the context without being
    // validated
    const unparsedEnv = app.node.tryGetContext(env);

    return {
        environment: env,
        appPrefix: ensureString(unparsedEnv, "appPrefix"),
        region: ensureString(unparsedEnv, "region"),
    };
};


// this function ensures that the value from the config is
// the correct type. If you have any types other than
// strings be sure to create a new validation function
function ensureString(
    object: { [name: string]: any },
    key: keyof BuildConfig
): string {
    if (
        !object[key] ||
        typeof object[key] !== "string" ||
        object[key].trim().length === 0
    ) {
        throw new Error(key + " does not exist in cdk config");
    }
    return object[key];
}