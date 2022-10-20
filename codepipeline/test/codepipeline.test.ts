import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as CodePipeline from '../lib/codepipeline-stack';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import { OriginAccessIdentity } from 'aws-cdk-lib/aws-cloudfront';
import { PolicyDocument, PolicyStatement } from 'aws-cdk-lib/aws-iam';

describe('Stack should have following resources', () => {

    const app = new cdk.App();

    const stack = new CodePipeline.CodepipelineStack(app, 'MyTestStack');
    const prefix = app.node.tryGetContext('PIPELINE-NAME-PREFIX') || 'prod'

    const template = Template.fromStack(stack);

    it('should have s3 resource', () => {
        template.hasResource('AWS::Lambda::Function', {});
    });

    it('should have lambda resource', () => {
        template.hasResource('AWS::S3::Bucket', {});
    });

    it('should have cloudfront resource', () => {
        template.hasResource('AWS::CloudFront::Distribution', {});
    });

    it('should have cloudfront resource', () => {
        template.hasResource('AWS::CloudFront::CloudFrontOriginAccessIdentity', {})
    });

    it('should have codepipeline resource', () => {
        template.hasResource('AWS::CodePipeline::Pipeline', {})
    });

    it('should have codebuild resource', () => {
        template.hasResource('AWS::CodeBuild::Project', {})
    });

    it('should have iam resource', () => {
        template.hasResource('AWS::IAM::Role', {});
    })
    it('should have 3 lambda resources', () => {
        template.resourceCountIs('AWS::Lambda::Function', 3);
    })

    it('should have 10 iam resources', () => {
        template.resourceCountIs('AWS::IAM::Role', 10);
    })

});

test('Stack should have resources following properties', () => {
    const app = new cdk.App();

    const stack = new CodePipeline.CodepipelineStack(app, 'MyTestStack');

    const template = Template.fromStack(stack);

    const prefix = app.node.tryGetContext('PIPELINE-NAME-PREFIX') || 'prod'

    template.hasResourceProperties("AWS::Lambda::Function", {
        Handler: "index.handler",
        Runtime: "nodejs14.x",
        FunctionName: `${prefix}-predeploy`,
        Timeout: 300,
    });

    template.hasResourceProperties("AWS::Lambda::Function", {
        Handler: "index.handler",
        Runtime: "nodejs14.x",
        FunctionName: `${prefix}-postdeploy`,
        Timeout: 300,
    });

    template.hasResourceProperties("AWS::Lambda::Function", {
        Handler: "index.handler",
        Runtime: "nodejs14.x",
        FunctionName: `${prefix}-cronlambda`,
        Timeout: 300,
    });


    template.hasResourceProperties("AWS::S3::Bucket", {
        BucketName: `${prefix}-oui-opensearch.org`,
        PublicAccessBlockConfiguration: { "BlockPublicPolicy": true },
        BucketEncryption: {
            ServerSideEncryptionConfiguration: [
                {
                    ServerSideEncryptionByDefault: {
                        SSEAlgorithm: "AES256",
                    },
                },
            ],
        },
    });

    template.hasResourceProperties("AWS::CodePipeline::Pipeline", {
        Name: "OuiSuperPipeline",
    })

    template.hasResourceProperties('AWS::IAM::Role', {
        'AssumeRolePolicyDocument': {
            'Statement': [
                {
                    "Action": "sts:AssumeRole",
                    "Effect": "Allow",
                    "Principal": {
                        "Service": "codepipeline.amazonaws.com"
                    }
                }
            ],
            'Version': '2012-10-17'
        }
    })

});