const AWS = require('aws-sdk');
const codepipeline = new AWS.CodePipeline();
const cloudfront = new AWS.CloudFront();

/* 
 * Note: `DESTINATION_KEY/` will be prefixed with `/` and suffixed with `/*` automatically.
 */

exports.handler = async (event, context) => {
    const { DESTINATION_BUCKET, DESTINATION_KEY, DISTRIBUTION_ID, TIMEOUT } = JSON.parse(event["CodePipeline.job"].data.actionConfiguration.configuration.UserParameters);
    console.log(`Incoming - DESTINATION_BUCKET: ${DESTINATION_BUCKET}, DESTINATION_KEY: ${DESTINATION_KEY}, DISTRIBUTION_ID: ${DISTRIBUTION_ID}`);

    const jobId = event["CodePipeline.job"].id;

    const sendSuccess = async data => {
        console.log('Success:', data?.message || data);
        await codepipeline.putJobSuccessResult({
            jobId: jobId,
            outputVariables: data
        }).promise();

        clearTimeout(timer);

        return data?.message || data;
    };

    const sendFailure = async data => {
        console.log('Failure:', data?.message || data);
        await codepipeline.putJobFailureResult({
            jobId: jobId,
            failureDetails: {
                message: JSON.stringify(data?.message || data),
                type: 'JobFailed',
                externalExecutionId: context.invokeid
            }
        }).promise();

        throw data?.message || data;
    };

    let timer = setTimeout(async () => {
        console.info('Timeout: Took too long to die!');
        console.error('Timeout: Took too long to die!');
        await sendFailure('Timeout');
        process.exit(1);
    }, TIMEOUT || 30000);

    process.on('uncaughtException', function (err) {
        console.info('uncaughtException');
        console.error(err.message || err)
        console.error(err.stack)
        process.exit(1)
    });

    try {
        const paths = [];
        if (Array.isArray(DESTINATION_KEY) && DESTINATION_KEY.length) {
            paths.push(...DESTINATION_KEY);
        } else if (typeof DESTINATION_KEY === 'string') {
            paths.push(DESTINATION_KEY);
        }

        if (paths.length === 0) {
            return await sendFailure('DESTINATION_KEY is not valid.');
        }

        const items = paths.flatMap(item => {
            if (!item) return '/*';
            if (/\/index\.html$/i.test(item)) return [`/${item}`, `/${item.replace(/\/index\.html$/i, '')}`];
            if (/\.[a-z]{2,5}$/i.test(item)) return `/${item}`;
            return [`/${item}`, `/${item}/*`];
        });

        const invalidationParams = {
            DistributionId: DISTRIBUTION_ID,
            InvalidationBatch: {
                CallerReference: Date.now().toString(),
                Paths: {
                    Quantity: items.length,
                    Items: items
                }
            }
        };

        console.info(`Calling CloudFront.createInvalidation on ${DISTRIBUTION_ID} for ${paths.length} path${paths.length === 1 ? '' : 's'}.`);
        const out = await cloudfront.createInvalidation(invalidationParams).promise();
        console.info('Finished with CloudFront.createInvalidation: ' + JSON.stringify(out, null, 2));

        return await sendSuccess({ message: `Postdeploy completed.` });
    } catch (ex) {
        console.error(ex);
        console.info(ex.stack);
        return await sendFailure(ex);
    }
};