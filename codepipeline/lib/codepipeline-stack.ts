import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Artifact, Pipeline } from 'aws-cdk-lib/aws-codepipeline';
import { readFileSync } from 'fs';
import * as CodePipelineActions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as CodeBuild from 'aws-cdk-lib/aws-codebuild';
import * as S3 from 'aws-cdk-lib/aws-s3';
import * as Lambda from 'aws-cdk-lib/aws-lambda';
import * as CloudFront from 'aws-cdk-lib/aws-cloudfront';
import * as IAM from 'aws-cdk-lib/aws-iam';
import { S3Origin } from "aws-cdk-lib/aws-cloudfront-origins";
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import * as Events from 'aws-cdk-lib/aws-events';
import * as Cr from 'aws-cdk-lib/custom-resources';
import { BuildSpec } from 'aws-cdk-lib/aws-codebuild';

export class CodepipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    /** constants  */

    const env = this.node.tryGetContext('config') || 'staging';
    const prefix = `${env}-oui-docs`;
    const preDeployLambda = `${prefix}-predeploy`;
    const postDeployLambda = `${prefix}-postdeploy`;
    const cloudfrontFunctionName = `${prefix}-index-resolver`
    const cronLambda = `${prefix}-cron`;
    const codePipelineTemplateName = `${prefix}-template`;
    const bucketName = `${prefix}-opensearch.org`;
    const accountID = cdk.Stack.of(this).account;
    const accountRegion = cdk.Stack.of(this).region;
    const gitOwner = "opensearch-project";
    const gitRepo = "oui";
    const gitBranch = "main";
    const gitArn = "XXXXX" // ASK OWNER
    const codePipelineServiceRoleSuffix = 'CodePipelineRole';
    const codePipelineID = 'CodePipeline';
    const codePipelineServiceRoleName = `${prefix}-pipeline-service-role`;

    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));


    /** Setup bucket that hosts the content  */
    const OuiBucket = new S3.Bucket(this, "S3Bucket", {
      encryption: S3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      blockPublicAccess: S3.BlockPublicAccess.BLOCK_ALL,
      bucketName: bucketName
    });

    const originAccessIdentity = new CloudFront.OriginAccessIdentity(this, 'OriginAccessIdentity');
    OuiBucket.grantRead(originAccessIdentity);


    // create cloudfront Function to a Distribution. it handles redirection 1.0/ to 1.0/index.html
    let cloudfrontFunctionSource = readFileSync('functions/oui-index-resolver/index.js', "utf8");
    if (env === 'prod') cloudfrontFunctionSource = cloudfrontFunctionSource.replace(/^const USE_LATEST.*$/, 'const USE_LATEST = false;');
    const cfFunction = new CloudFront.Function(this, 'Function', {
      code: CloudFront.FunctionCode.fromInline(cloudfrontFunctionSource),
      comment: 'Handle Redirections for e.g 1.0/ to 1.0/index.html',
      functionName: cloudfrontFunctionName
    });

    /** Setup CDN to host the website  */
    const cdnDistribution = new CloudFront.Distribution(this, 'OuiDistribution', {
      defaultBehavior: {
        origin: new S3Origin(OuiBucket, { originAccessIdentity }),
        viewerProtocolPolicy: CloudFront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: CloudFront.CachePolicy.CACHING_OPTIMIZED,
        functionAssociations: [{
          function: cfFunction,
          eventType: CloudFront.FunctionEventType.VIEWER_REQUEST,
        }]
      },
    });

    /** Create IAM Role for codepipeline & add necessary policies  */
    const role = new IAM.Role(this, codePipelineServiceRoleSuffix, {
      assumedBy: new IAM.ServicePrincipal('codepipeline.amazonaws.com'),
      roleName: codePipelineServiceRoleName,
      inlinePolicies: {
        rootPermissions: new IAM.PolicyDocument({
          statements: [
            new IAM.PolicyStatement({
              resources: ['*'],
              actions: ['*'],
            }),
          ],
        }),
      }

    });

    /** Setup template pipeline  */
    const pipeline = new Pipeline(this, codePipelineID, {
      pipelineName: codePipelineTemplateName,
      crossAccountKeys: false,
      role: role.withoutPolicyUpdates()
    });

    /** Input/Outputs */
    const SourceArtifact = new Artifact();
    const BuildArtifact = new Artifact();

    /** GitHub action  */
    const pullFromGithubAction = new CodePipelineActions.CodeStarConnectionsSourceAction({
      owner: gitOwner,
      repo: gitRepo,
      branch: gitBranch,
      actionName: "GithubSource",
      connectionArn: gitArn,
      triggerOnPush: true, // Controls automatically starting your pipeline when a new commit is made on the configured repository and branch.
      output: SourceArtifact,
    });

    //Declare a new CodeBuild project
    const buildSpecYml = readFileSync('build-spec.yml', "utf8");

    const buildProject = new CodeBuild.PipelineProject(this, 'OuiBuildProject', {

      buildSpec: CodeBuild.BuildSpec.fromSourceFilename(buildSpecYml),
      environment: {
        buildImage: CodeBuild.LinuxBuildImage.STANDARD_6_0
      },
    });


    /** Build Action  */
    const codeBuildAction = new CodePipelineActions.CodeBuildAction({
      actionName: 'BuildOui',
      project: buildProject,
      input: SourceArtifact,
      outputs: [BuildArtifact],
      variablesNamespace: 'BuildVariables'
    })

    /** Deploy Action  */
    const s3DeployAction = new CodePipelineActions.S3DeployAction({
      actionName: 'S3Deploy',
      bucket: OuiBucket,
      input: BuildArtifact,
      variablesNamespace: "DeployVariables",
      extract: true,
      objectKey: codeBuildAction.variable('DESTINATION_KEY'),
      runOrder: 2
    });

    /** Pipeline 1st stage Source */
    const sourceStage = pipeline.addStage({
      stageName: "Source",
      actions: [pullFromGithubAction],
    });

    /** Pipeline 2nd stage Build */
    const buildStage = pipeline.addStage({
      stageName: 'Build',
      placement: {
        justAfter: sourceStage,
      },
      actions: [codeBuildAction],
    });

    /** =======================Policies START =======================================*/
    const preDeployBucketPolicyStatement = new IAM.PolicyStatement(
      {
        effect: IAM.Effect.ALLOW,
        actions: ["s3:ListBucket", "s3:DeleteObject"],
        resources: [`arn:aws:s3:::${OuiBucket.bucketName}/*`, `arn:aws:s3:::${OuiBucket.bucketName}`],
      })

    const codePipelinePolicyStatement = new IAM.PolicyStatement(
      {
        effect: IAM.Effect.ALLOW,
        actions: ["codepipeline:PutJobFailureResult", "codepipeline:PutJobSuccessResult"],
        resources: ["*"],
      })

    const cloudFrontPolicyStatement = new IAM.PolicyStatement(
      {
        effect: IAM.Effect.ALLOW,
        actions: ["cloudfront:CreateInvalidation", "logs:CreateLogGroup"],
        resources: [
          `arn:aws:cloudfront::${accountID}:distribution/${cdnDistribution.distributionId}`,
          `arn:aws:logs:${accountRegion}:${accountID}:*`
        ],
      })

    const preDeployLambdaLogPolicyStatementStatement = new IAM.PolicyStatement(
      {
        effect: IAM.Effect.ALLOW,
        actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
        resources: [`arn:aws:logs:${accountRegion}:${accountID}:log-group:/aws/lambda/${preDeployLambda}:*`],
      })

    const postDeployLambdaLogsPolicyStatement = new IAM.PolicyStatement(
      {
        effect: IAM.Effect.ALLOW,
        actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
        resources: [`arn:aws:logs:${accountRegion}:${accountID}:log-group:/aws/lambda/${postDeployLambda}:*`],
      })

    const cronLambdaBucketPolicyStatement = new IAM.PolicyStatement(
      {
        effect: IAM.Effect.ALLOW,
        actions: [
          "s3:*Object",
          "sts:AssumeRole",
          "logs:CreateLogStream",
          "codepipeline:StartPipelineExecution",
          "codepipeline:GetPipeline",
          "codepipeline:CreatePipeline",
          "cloudfront:GetFunction",
          "cloudfront:UpdateFunction",
          "cloudfront:PublishFunction",
          "codepipeline:ListPipelines",
          "s3:ListBucket",
          "codepipeline:GetPipelineState",
          "logs:PutLogEvents",
          "codepipeline:GetPipelineExecution"
        ],

        resources: [

          `arn:aws:codepipeline:*:${accountID}:*`,
          `arn:aws:cloudfront::${accountID}:function/${cloudfrontFunctionName}`,
          `arn:aws:codepipeline:*:${accountID}:${codePipelineTemplateName}*`,
          `arn:aws:s3:::${OuiBucket.bucketName}/*`,
          `arn:aws:s3:::${OuiBucket.bucketName}`,
          `arn:aws:logs:${accountRegion}:${accountID}:log-group:/aws/lambda/${cronLambda}:*`
        ],
      });

    const cronLambdaLogPolicyStatement = new IAM.PolicyStatement(
      {
        effect: IAM.Effect.ALLOW,
        actions: ["iam:PassRole", "logs:CreateLogGroup", "codestar-connections:PassConnection"],
        resources: [
          `arn:aws:iam::${accountID}:role/CodepipelineStack-${codePipelineID}*`,
          `arn:aws:iam::${accountID}:role/CodepipelineStack-${codePipelineID}*/*`,
          `arn:aws:logs:${accountRegion}:${accountID}:*`,
          `arn:aws:iam::${accountID}:role/${codePipelineServiceRoleName}`,
          gitArn
        ]

      });

    /** =======================Policies END =======================================*/

    /** =======================Lambda START =======================================*/

    /** preDeploy lambda to empty s3 */
    const preDeployLambdaFunction = new Lambda.Function(this, 'OuiPreDeployHandler', {
      runtime: Lambda.Runtime.NODEJS_14_X,
      code: Lambda.Code.fromAsset('lambda/predeploy'),
      handler: 'index.handler',
      functionName: preDeployLambda,
      timeout: cdk.Duration.minutes(5),
      description: 'Empty S3 Directory'
    });

    /** Add policies to predeploy lambda  */
    preDeployLambdaFunction.addToRolePolicy(preDeployBucketPolicyStatement);
    preDeployLambdaFunction.addToRolePolicy(codePipelinePolicyStatement);
    preDeployLambdaFunction.addToRolePolicy(preDeployLambdaLogPolicyStatementStatement);

    /* Create Lambda Action */
    const preDeplyLambdaAction = new CodePipelineActions.LambdaInvokeAction({
      actionName: 'PreDeployLambda',
      lambda: preDeployLambdaFunction,
      userParameters: {
        'DESTINATION_KEY': codeBuildAction.variable('DESTINATION_KEY'),
        'DISTRIBUTION_ID': cdnDistribution.distributionId,
        'DESTINATION_BUCKET': OuiBucket.bucketName
      },
      runOrder: 1
    });

    /** postDeploy lambda to empty s3 */
    const postDeployLambdaFunction = new Lambda.Function(this, 'OuiPostDeployHandler', {
      runtime: Lambda.Runtime.NODEJS_14_X,
      code: Lambda.Code.fromAsset('lambda/postdeploy'),
      handler: 'index.handler',
      functionName: postDeployLambda,
      timeout: cdk.Duration.minutes(5),
      description: 'Invalidate CloudFront Cache'
    });

    /** Add policies to postdeploy lambda  */
    postDeployLambdaFunction.addToRolePolicy(postDeployLambdaLogsPolicyStatement);
    postDeployLambdaFunction.addToRolePolicy(codePipelinePolicyStatement)
    postDeployLambdaFunction.addToRolePolicy(cloudFrontPolicyStatement)

    const postDeplyLambdaAction = new CodePipelineActions.LambdaInvokeAction({
      actionName: 'PostDeployLambda',
      lambda: postDeployLambdaFunction,
      userParameters: {
        'DESTINATION_KEY': codeBuildAction.variable('DESTINATION_KEY'),
        'DISTRIBUTION_ID': cdnDistribution.distributionId,
        'DESTINATION_BUCKET': OuiBucket.bucketName
      },
      runOrder: 3
    });

    /** =======================Lambda END =======================================*/

    /** Pipeline 3rd stage Deploy*/
    const deployStage = pipeline.addStage({
      stageName: 'Deploy',
      placement: {
        justAfter: buildStage,
      },
      actions: [preDeplyLambdaAction, s3DeployAction, postDeplyLambdaAction]
    });

    /** =======================SuperPipeLine END =======================================*/

    /** =======================CronLambda Start =======================================*/
    /** This lambda will run periodically & will use above codepipeline as template. We will be setting this up in Amazon Eventbridge  */
    /* Lambda that creates new pipelines for all release branches for e.g 1.0 (including 'main' for staging) */

    const cronLambdaSource = readFileSync('./lambda/cron/index.js', "utf8");

    /** cron lambda function */
    const CronLambdaFunction = new Lambda.Function(this, 'OuiCronLambdaHandler', {
      runtime: Lambda.Runtime.NODEJS_14_X,
      code: Lambda.Code.fromInline(cronLambdaSource),
      handler: 'index.handler',
      functionName: cronLambda,
      timeout: cdk.Duration.minutes(5),
      environment: {
        CODEPIPELINE_NAME: codePipelineTemplateName,
        S3_BUCKET_NAME: OuiBucket.bucketName,
        PREFIX: prefix,
        CLOUDFRONT_FUNCTION_NAME: cloudfrontFunctionName,
      },
      description: 'Run periodically, Use Superpipeline as template & Create new codepipelines for release branches.'
    });


    CronLambdaFunction.addToRolePolicy(cronLambdaBucketPolicyStatement);
    CronLambdaFunction.addToRolePolicy(codePipelinePolicyStatement);
    CronLambdaFunction.addToRolePolicy(cronLambdaLogPolicyStatement);


    /** =======================CronLambda  END =======================================*/



    /** Create Rule to scheule cronlambda */
    const ruleForCheck = new Events.Rule(this, 'InvokeCron', {
      schedule: Events.Schedule.expression('cron(0 1,13,17,21 * * ? *)'),
      ruleName: `invoke-${env}-oui-cron-lambda`,
      description: 'invoke cron lambda to create oui release pipelines'
    });

    ruleForCheck.addTarget(new LambdaFunction(CronLambdaFunction));

    /** Invoke cronlambda for the first time when stack is deployed */
    // (async function () { // wait till codepipeline gets created
    //   await sleep(60000);
    // })();


    const lambdaTrigger = new Cr.AwsCustomResource(this, 'CronLambdaTrigger', {
      policy: Cr.AwsCustomResourcePolicy.fromStatements([new IAM.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        effect: IAM.Effect.ALLOW,
        resources: [CronLambdaFunction.functionArn]
      })]),
      timeout: cdk.Duration.minutes(5),
      onCreate: {
        service: 'Lambda',
        action: 'invoke',
        parameters: {
          FunctionName: CronLambdaFunction.functionName,
          InvocationType: 'Event'
        },
        physicalResourceId: Cr.PhysicalResourceId.of('CronLambdaTriggerId')
      },
      onUpdate: {
        service: 'Lambda',
        action: 'invoke',
        parameters: {
          FunctionName: CronLambdaFunction.functionName,
          InvocationType: 'Event'
        },
        physicalResourceId: Cr.PhysicalResourceId.of('CronLambdaTriggerId')
      }
    })

  }


}


