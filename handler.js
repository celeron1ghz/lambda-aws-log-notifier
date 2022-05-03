'use strict';

const Slack = require('slack-node');
const slack = new Slack();
const zlib = require('zlib');
const aws = require('aws-sdk');
const logs = new aws.CloudWatchLogs();
const lambda = new aws.Lambda();

module.exports.main = async (event, context, callback) => {
  try {
    const zip = await new Promise((resolve,reject) =>
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

    slack.setWebhook(process.env.SLACK_WEBHOOK_URL);

    const ret = await new Promise((resolve,reject) =>
      slack.webhook({
        username: username,
        mrkdwn: true,
        attachments: param,
      }, (err,res) => { if (err) { reject(err) } else { resolve(res) } })
    );

    console.log(ret);
    callback(null, "OK");
  } catch (err) {
    console.log("Error:", err);
    callback(err);
  }
};

module.exports.appender = async (event, context, callback) => {
  const logGroup = event.detail.requestParameters.logGroupName;
  const skipLogGroup = process.env.SKIP_LOG_GROUP.split(',');

  if (skipLogGroup.filter(l => l.name === logGroup).length !== 0) {
    console.log("SKIP_SUCSCRIPTION", logGroup);
    return callback(null,"OK");
  }

  try {
    const thisArn = await lambda.getFunction({ FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME })
      .promise()
      .then(data => data.Configuration.FunctionArn);

    const loggerArns = ['main', 'main2'].map(t => thisArn.replace('appender', t));

    if (event.detail.eventName === "CreateLogGroup" && logGroup.match(/^aws\/lambda/)) {
        await CreateLogGroup(logGroup, loggerArns);
    }

    if (event.detail.eventName === "DeleteLogGroup") {
        await DeleteLogGroup(logGroup, loggerArns);
    }

    callback(null, "OK");
  } catch (err) {
    console.log("Error:", err);
    callback(null, err);
  }
};


async function CreateLogGroup (logGroup, loggerArns) {
  const notEmptyLoggerArn = loggerArns.map(async arn =>
    await lambda.getPolicy({ FunctionName: arn })
      .promise()
      .then(ret => { return { raw: ret.Policy, data: JSON.parse(ret.Policy) }; })
      .catch(err => null)
  );

  for (const loggerArn of loggerArns) {
    const arns      = loggerArn.split(":");
    const splitted  = logGroup.split('/');
    const Region    = arns[3];
    const AccountId = arns[4];
    const stmtId    = splitted[splitted.length - 1];

    const ret = await lambda.getPolicy({ FunctionName: loggerArn })
      .promise()
      .then(ret => { return { raw: ret.Policy, data: JSON.parse(ret.Policy) }; })
      .catch(err => null);

    if (ret)    {
      if (ret.raw.length > 20000)   { // policy limit size is 20480
        console.log("POLICY_SIZE_LIMIT", loggerArn);
        continue;
      }
    }

    console.log("SUBSCRIBE", logGroup, "to", loggerArn);

    await lambda.addPermission({
      Action: "lambda:InvokeFunction",
      FunctionName: loggerArn,
      Principal: `logs.${Region}.amazonaws.com`,
      SourceArn: `arn:aws:logs:${Region}:${AccountId}:log-group:${logGroup}:*`,
      StatementId: stmtId,
    }).promise().catch(err => { console.log("Error on addPermission:", err) });

    await logs.putSubscriptionFilter({
      logGroupName: logGroup,
      filterName: logGroup,
      filterPattern: '',
      destinationArn: loggerArn,
    }).promise().catch(err => { console.log("Error on putSubscriptionFilter:", err) });
    return;
  }
}

async function DeleteLogGroup (logGroup, loggerArns) {
  const splitted  = logGroup.split('/');
  const stmtId = splitted[splitted.length - 1];

  for (const loggerArn of loggerArns) {
    const ret = await lambda.getPolicy({ FunctionName: loggerArn }).promise()
      .then(ret => { return { raw: ret.Policy, data: JSON.parse(ret.Policy) }; })
      .catch(err => null);

    if (ret)    {
      // policy exist check
      if (ret.data.Statement.filter(s => s.Sid === stmtId).length == 0)  {
        console.log("PERMISSION_NOT_EXIST", stmtId, "on", loggerArn);
        continue;
      }
    }

    console.log("UNSUBSCRIBE", logGroup, "from", loggerArn);

    await lambda.removePermission({ FunctionName: loggerArn, StatementId: stmtId })
      .promise()
      .catch(err => { console.log("Error on removePermission:", err) });
    return;
  }
}
