// Only the isolated Compose replica set; never an existing application database.
try {
  const status = rs.status();
  if (status.set !== 'production-lab') throw new Error('Unexpected replica set');
} catch (error) {
  if (error.code !== 94) throw error;
  rs.initiate({_id:'production-lab',members:[{_id:0,host:'mongo:27017'}]});
}
for (let attempt=0;attempt<60;attempt++) {
  if (db.hello().isWritablePrimary) quit(0);
  sleep(500);
}
throw new Error('Isolated primary did not become ready');
