// Static-scanner fixtures, not executable application code.
declare const jwt: any, token: any, secret: any, req: any, model: any, child: any, res: any, error: any;
// ruleid: tls-verification-disabled
const badTls = {rejectUnauthorized: false};
// ok: tls-verification-disabled
const goodTls = {rejectUnauthorized: true};
// ruleid: global-tls-verification-disabled
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
// ok: global-tls-verification-disabled
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "1";
// ruleid: jwt-unbounded-verification
jwt.verify(token, secret);
// ok: jwt-unbounded-verification
jwt.verify(token, secret, {algorithms: ['HS256'], issuer: 'synthetic', audience: 'synthetic'});
// ruleid: raw-request-mongo-query
model.find(req.body);
// ok: raw-request-mongo-query
model.find({category: 'synthetic'});
// ruleid: raw-request-shell-execution
child.exec(req.body.command);
// ok: raw-request-shell-execution
child.execFile('node', ['--version']);
// ruleid: error-stack-response
res.json({stack: error.stack});
// ok: error-stack-response
res.json({message: 'Request failed'});
