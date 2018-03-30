'use strict';

process.env.AWS_REGION = 'ap-northeast-1';

const vo  = require('vo');
const aws = require('aws-sdk');
const logs = new aws.CloudWatchLogs();
const lambda = new aws.Lambda();

const sleep = () => new Promise((resolve,reject) => setTimeout(resolve, 1000));

vo(function*(){
  const policy = yield lambda.getPolicy({ FunctionName: "aws-log-notifier-dev-main" }).promise();
  const policies = JSON.parse(policy.Policy);

  for (const p of policies.Statement) {
      console.log("remove lambda perm", p.Sid);
      yield lambda.removePermission({
        FunctionName: "aws-log-notifier-dev-main",
        StatementId: p.Sid,
      }).promise();
  }

  const logGroups = yield logs.describeLogGroups()
    .promise()
    .then(data => data.logGroups.map(l => { return { name: l.logGroupName }; }));

  for (const log of logGroups) {
    const subs = yield logs.describeSubscriptionFilters({ logGroupName: log.name }).promise().then(data => data.subscriptionFilters);

    for (const s of subs) {
      console.log("remove subscription", s.filterName);

      yield logs.deleteSubscriptionFilter({
        filterName: s.filterName,
        logGroupName: s.logGroupName,
      }).promise();

      yield sleep();
    }
  }

  console.log("OK");
})
.catch(err => {
  console.log("Error:", err);
});
