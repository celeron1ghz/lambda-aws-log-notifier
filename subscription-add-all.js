'use strict';

process.env.AWS_REGION = 'ap-northeast-1';

const vo  = require('vo');
const aws = require('aws-sdk');
const logs = new aws.CloudWatchLogs();
const lambda = new aws.Lambda();

const sleep = () => new Promise((resolve,reject) => setTimeout(resolve, 1000));

vo(function*(){
  const skipLogGroup = "netatmo2lametric,aws-log-notifier-dev-main,codedeploy-agent,aws-status-notifier,codedeploy-updater".split(',');
  const loggerLambdaArn = yield lambda.getFunction({ FunctionName: "aws-log-notifier-dev-main" })
    .promise()
    .then(data => data.Configuration.FunctionArn.replace('updater', 'main'));

  const splitted  = loggerLambdaArn.split(":");
  const Region    = splitted[3];
  const AccountId = splitted[4];

  const logGroups = yield logs.describeLogGroups()
    .promise()
    .then(data => data.logGroups.map(l => { return { name: l.logGroupName }; }));

  const filtered = logGroups.filter(l => skipLogGroup.filter(s => l.name.match(s)).length === 0);

  for (const log of filtered) {
    yield sleep();

    const subscribed =
      yield logs.describeSubscriptionFilters({ logGroupName: log.name })
        .promise()
        .then(data => data.subscriptionFilters.filter(s => s.destinationArn === loggerLambdaArn).length);

    if (subscribed) {
      console.log("ALREADY_SUBSCRIBED", log.name);
      continue;
    }

    console.log("SUBSCRIBE", log.name);

    const splitted = log.name.split('/');
    const basename = splitted[splitted.length - 1];

    yield lambda.addPermission({
      Action: "lambda:InvokeFunction",
      FunctionName: loggerLambdaArn,
      Principal: `logs.${Region}.amazonaws.com`,
      SourceArn: `arn:aws:logs:${Region}:${AccountId}:log-group:${log.name}:*`,
      StatementId: basename,
    }).promise();

    yield logs.putSubscriptionFilter({
      logGroupName: log.name,
      filterName: log.name,
      filterPattern: '',
      destinationArn: loggerLambdaArn,
    }).promise();
  }

  console.log("OK");
})
.catch(err => {
  console.log("Error:", err);
});
