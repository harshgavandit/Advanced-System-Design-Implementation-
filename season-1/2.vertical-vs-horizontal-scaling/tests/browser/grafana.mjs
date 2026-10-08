import {chromium} from 'playwright';
import {writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const password=process.env.LAB_GRAFANA_SECRET;
assert.ok(password,'Explicit local Grafana credential is required');
const report={startedAt:new Date().toISOString(),passed:false,synthetic:true,image:process.env.LAB_TESTED_IMAGE,sourceTreeSha256:process.env.LAB_TESTED_SOURCE};
assert.match(report.image??'',/^sha256:[a-f0-9]{64}$/,'Bind browser proof to the inspected serving image');
assert.match(report.sourceTreeSha256??'',/^[a-f0-9]{64}$/,'Bind browser proof to the inspected serving source');
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({viewport:{width:1600,height:1050},httpCredentials:{username:'lab-admin',password}});
const page=await context.newPage(),errors=[],requests=[];
page.on('pageerror',error=>errors.push(error.message.slice(0,200)));
page.on('response',response=>{if(response.url().includes('/api/ds/query'))requests.push({status:response.status()});});
try{
  await page.goto('http://grafana:3000/d/catalog-production-lab?from=now-2h&to=now&refresh=1m',{waitUntil:'domcontentloaded'});
  if(page.url().includes('/login')){
    console.log('BROWSER_LOGIN_FORM',JSON.stringify(await page.locator('input').evaluateAll(elements=>elements.map(element=>({name:element.name,type:element.type,placeholder:element.placeholder})))));
    await page.locator('input[name="user"]').fill('lab-admin');
    await page.locator('input[name="password"]').fill(password);
    await page.getByRole('button',{name:'Log in',exact:true}).click();
  }
  await page.getByText('Scaling Lab | Service, Users and Durable Jobs',{exact:true}).first().waitFor({timeout:60000});
  await page.getByText('Ready API processes',{exact:true}).waitFor({timeout:30000});
  // Wait for real datasource responses instead of relying on a timed screenshot.
  await page.waitForFunction(()=>document.body.innerText.includes('10 K')||document.body.innerText.includes('10,000')||document.body.innerText.includes('10000'),undefined,{timeout:60000});
  assert.ok(requests.some(row=>row.status===200),'Dashboard must query the real datasource');
  const text=await page.locator('body').innerText();assert.ok(text.includes('Synthetic stored profiles'));assert.ok(text.includes('Live local synthetic workload'));
  assert.ok(!text.includes('Data source not found'));
  await page.waitForLoadState('networkidle',{timeout:30000});
  // A stat-panel sparkline is not proof that the visible time-series rendered.
  for(const name of ['Catalog traffic distributed across replicas','Combined edge p95 / p99, not averaged replica quantiles','Whole-container CPU versus assigned quota','Whole-container memory, separate from process RSS']){
    const panel=page.getByRole('region',{name,exact:true});
    await panel.locator('canvas').first().waitFor({timeout:60000});
    assert.ok(!(await panel.innerText()).includes('No data'),name+' has no real series');
  }
  const latency=page.getByRole('region',{name:'Combined edge p95 / p99, not averaged replica quantiles',exact:true});
  await latency.getByText('p95',{exact:true}).waitFor({timeout:30000});
  await latency.getByText('p99',{exact:true}).waitFor({timeout:30000});
  await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
  await page.screenshot({path:'/results/live-grafana-dashboard.png',fullPage:false});
  await page.getByText('Durable job reconciliation, global values use max',{exact:true}).scrollIntoViewIfNeeded();
  const jobs=page.getByRole('region',{name:'Durable job reconciliation, global values use max',exact:true});
  await jobs.locator('canvas').first().waitFor({timeout:60000});
  await jobs.getByText('accepted',{exact:true}).waitFor({timeout:30000});
  const pending=page.getByRole('region',{name:'Pending job / outbox age and queue depth',exact:true});
  await pending.locator('canvas').first().waitFor({timeout:60000});
  await pending.getByText('queueVisible',{exact:true}).waitFor({timeout:30000});
  await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
  await page.waitForLoadState('networkidle',{timeout:30000});
  await page.screenshot({path:'/results/live-grafana-jobs.png',fullPage:false});
  assert.deepEqual(errors,[],'Dashboard has browser JavaScript failures');
  Object.assign(report,{passed:true,url:'http://127.0.0.1:13002/d/catalog-production-lab',datasourceResponses:requests,screenshots:['live-grafana-dashboard.png','live-grafana-jobs.png'],browserErrors:errors});
  console.log('GRAFANA_BROWSER_PASS real dashboard queries, synthetic counts and screenshots');
}catch(error){
  report.failure=error.message;
  console.log('BROWSER_DIAGNOSTIC',JSON.stringify({url:page.url(),text:(await page.locator('body').innerText()).slice(0,1800),inputs:await page.locator('input').evaluateAll(elements=>elements.map(element=>({name:element.name,type:element.type,placeholder:element.placeholder}))),errors}));
  await page.screenshot({path:'/results/grafana-browser-failure.png'});
  throw error;
}finally{report.finishedAt=new Date().toISOString();await writeFile('/results/browser-verification.json',JSON.stringify(report,null,2)+'\n');await browser.close();}
