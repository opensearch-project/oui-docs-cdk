/*Initialization */
const https = require('https');
const AWS = require('aws-sdk');
const CloudFront = new AWS.CloudFront();
const CodePipeline = new AWS.CodePipeline();
const S3 = new AWS.S3();
const GITHUB_STATUS_ENDPOINT = "https://api.github.com/repos/opensearch-project/oui/branches";
const CODEPIPELINE_NAME = process.env['CODEPIPELINE_NAME'];
const PREFIX = process.env['PREFIX'];
const S3_BUCKET_NAME = process.env['S3_BUCKET_NAME'];
const CLOUDFRONT_FUNCTION_NAME = process.env['CLOUDFRONT_FUNCTION_NAME'];
const BRANCH_MATCHER = /^\d+\.\d+$/;
const S3_CACHE_PARAMS = {
    Bucket: S3_BUCKET_NAME,
    Key: 'versions.json',
};
const CLOUDFRONT_FUNCTION_PARAMS = {
    Name: CLOUDFRONT_FUNCTION_NAME, /* required */
    Stage: 'DEVELOPMENT'
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

const numericCollator = new Intl.Collator('us', { sensitivity: 'base', numeric: true });

/**
 * @param {string} url
 * @returns Promise<{body: string}>
 */
const fetch = async (url) => new Promise((resolve, reject) => {
    const req = https.get(url, {
        headers: {
            "User-Agent": "oui"
        }
    }, res => {
        const body = [];
        res.on('data', chunk => body.push(chunk.toString()));
        res.on('end', () =>
            (res.statusCode >= 200 && res.statusCode <= 299 ? resolve : reject)({
                statusCode: res.statusCode,
                headers: res.headers,
                body: body.join(''),
            })
        );
    });
    req.on('error', reject);
});

exports.handler = async () => {
    console.log('Getting remote branches...');
    const {
        body: branchesData
    } = await fetch(GITHUB_STATUS_ENDPOINT);
    const allBranches = JSON.parse(branchesData);
    console.log(`Received ${allBranches.length} branches`);

    /* check branch and check if pipeline for that branch exists.. if exist , remove from changedBranches */
    console.log('Listing existing pipelines...');
    const {
        pipelines
    } = await CodePipeline.listPipelines({}).promise();
    const existingPipelines = pipelines.map((pipeline) => pipeline['name']);

    const remoteNumberedBranches = allBranches.reduce((res, branch) => {
        if (BRANCH_MATCHER.test(branch.name)) res.push(branch.name);
        return res;
    }, []);

    let newBranches = PREFIX === 'prod' ? [] : ['main'];
    newBranches.push(...remoteNumberedBranches);
    newBranches = newBranches.filter(name => !existingPipelines.includes(`${PREFIX}-${name}-opensearch.org`));

    if (newBranches.length === 0) {
        console.log('No Missing Pipelines...!');
    } else {
        console.log(`Found ${newBranches.length} changed branches`);

        // Fetch the template pipeline to reuse
        const {
            metadata,
            ...pipelineObject
        } = await CodePipeline.getPipeline({
            name: CODEPIPELINE_NAME,
        }).promise();

        let failed = false;

        for (const name of newBranches) {
            console.log(`Starting work on ${name}...`);

            try {
                pipelineObject.pipeline.stages.forEach(stage => {
                    if (stage.name === 'Source')
                        stage.actions[0].configuration.BranchName = name;
                    else if (stage.name === 'Build') {
                        stage.actions[0].configuration.EnvironmentVariables = `[{"name":"SOURCE_BRANCH","value":"${name}","type":"PLAINTEXT"}]`;
                    }
                });

                const newPipelineName = `${PREFIX}-${name}-opensearch.org`;
                pipelineObject.pipeline.name = newPipelineName;

                console.log(`Creating pipeline ${newPipelineName} for ${name}...`);

                CodePipeline.createPipeline({
                    ...pipelineObject,
                }, (err, data) => {
                    console.log('createPipeline', err, data);
                });

                await sleep(10000);

                console.log(`Starting pipeline ${newPipelineName} for ${name}...`);

            } catch (ex) {
                console.log('Caught:', ex);
                failed = true;
            }

        }
    }

    // Reverse sort the versions
    remoteNumberedBranches.sort((x, y) => numericCollator.compare(y, x));

    await S3.upload({
        ...S3_CACHE_PARAMS,
        Body: JSON.stringify(remoteNumberedBranches)
    }).promise();

    const latestVersion = remoteNumberedBranches[0];
    const response = await CloudFront.getFunction(CLOUDFRONT_FUNCTION_PARAMS).promise();
    const functionCode = response.FunctionCode.toString('utf8');
    const updatedCode = functionCode.replace(/^var\sLATEST_VERSION.*$/m, `var LATEST_VERSION = '${latestVersion}';`);

    console.log("updating cloudfront function...!");
    const { ETag: updatedETag } = await CloudFront.updateFunction({
        FunctionCode: Buffer.from(updatedCode),
        FunctionConfig: {
            Comment: 'Handle redirections',
            Runtime: 'cloudfront-js-1.0'
        },
        IfMatch: response.ETag,
        Name: CLOUDFRONT_FUNCTION_NAME
    }).promise();

    console.log("publishing cloudfront function...!");
    const publishResponse = await CloudFront.publishFunction({
        IfMatch: updatedETag,
        Name: CLOUDFRONT_FUNCTION_NAME
    }).promise();
};