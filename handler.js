'use strict';

const Slack = require('slack-node');
const slack = new Slack();
const zlib = require('zlib');
const vo  = require('vo');
const aws = require('aws-sdk');
const ssm = new aws.SSM();
const logs = new aws.CloudWatchLogs();
const lambda = new aws.Lambda();

module.exports.main = (event, context, callback) => {
  vo(function*(){
    const zip = yield new Promise((resolve,reject) =>
      zlib.gunzip(new Buffer(event.awslogs.data, 'base64'), (err, res) => {
        if (err) { reject(err) } else { resolve(res) }
      })
    );

    const parsed = JSON.parse(zip.toString('utf8'));
    console.log('Decoded payload:', JSON.stringify(parsed));

    let param;
    let username = parsed.logGroup;

    if (parsed.logGroup.match(/^\/aws\/lambda\//))  {
      username = parsed.logGroup.replace('/aws/lambda/', '');
      param = parsed.logEvents
        .filter(m => !m.message.match(/^START/))
        .filter(m => !m.message.match(/^END/))
        .filter(m => !m.message.match(/^REPORT/))
        .map(m => { const splitted = m.message.split("\t", 3); return splitted.length == 1 ? m.message : splitted[2]; })
        .map(m => { return { color: "good", text: m, mrkdwn_in: ['text'] } });
    }
    else {
      param = parsed.logEvents.map( d => { return { color: "good", text: d.message, mrkdwn_in: ['text'] } });
    }

    if (param.length == 0)  {
      console.log("matched nothing");
      return callback(null, 'NOP');
    }

    const url = (yield ssm.getParameter({ Name: '/slack/webhook/rawLog', WithDecryption: true }).promise() ).Parameter.Value;
    slack.setWebhook(url);

    const ret = yield new Promise((resolve,reject) =>
      slack.webhook({
        username: username,
        mrkdwn: true,
        attachments: param,
      }, (err,res) => { if (err) { reject(err) } else { resolve(res) } })
    );

    console.log(ret);
    callback(null, "OK");
  })
  .catch(err => {
    console.log("Error:", err);
    callback(err);
  });
};

module.exports.appender = (event, context, callback) => {
  const logGroup = event.detail.requestParameters.logGroupName;
  const skipLogGroup = process.env.SKIP_LOG_GROUP.split(',');

  if (skipLogGroup.filter(l => l.name === logGroup).length !== 0) {
    console.log("SKIP_SUCSCRIPTION", logGroup);
    return callback(null,"OK");
  }

  vo(function*(){
    const loggerLambdaArn = yield lambda.getFunction({ FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME })
      .promise()
      .then(data => data.Configuration.FunctionArn.replace('appender', 'main'));

    const arn       = loggerLambdaArn.split(":");
    const Region    = arn[3];
    const AccountId = arn[4];
    const splitted  = logGroup.split('/');
    const basename  = splitted[splitted.length - 1];

    if (event.detail.eventName === "CreateLogGroup") {
      console.log("SUBSCRIBE", logGroup);

      yield lambda.addPermission({
        Action: "lambda:InvokeFunction",
        FunctionName: loggerLambdaArn,
        Principal: `logs.${Region}.amazonaws.com`,
        SourceArn: `arn:aws:logs:${Region}:${AccountId}:log-group:${logGroup}:*`,
        StatementId: basename,
      }).promise();

      yield logs.putSubscriptionFilter({
        logGroupName: logGroup,
        filterName: logGroup,
        filterPattern: '',
        destinationArn: loggerLambdaArn,
      }).promise();
    }

    if (event.detail.eventName === "DeleteLogGroup") {
      console.log("UNSUBSCRIBE", logGroup);

      yield lambda.removePermission({
        FunctionName: loggerLambdaArn,
        StatementId: basename,
      }).promise();
    }

    callback(null,"OK");
  })
  .catch(err => {
    console.log("Error:", err);
    callback(err);
  });
};