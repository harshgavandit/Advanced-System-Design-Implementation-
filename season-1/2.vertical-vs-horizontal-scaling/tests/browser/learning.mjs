import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {writeFile} from 'node:fs/promises';
const report={passed:false,synthetic:true,startedAt:new Date().toISOString(),image:process.env.LAB_TESTED_IMAGE,sourceTreeSha256:process.env.LAB_TESTED_SOURCE};
assert.match(report.image??'',/^sha256:[a-f0-9]{64}$/);
assert.match(report.sourceTreeSha256??'',/^[a-f0-9]{64}$/);
const browser=await chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:1600,height:1050}});
const errors=[],queries=[];
page.on('pageerror',error=>errors.push(error.message));
page.on('response',response=>{if(response.url().includes('/api/ds/query'))queries.push(response.status());});
try{
  await page.goto('http://grafana:3000/d/local-learning-lab?from=now-1h&to=now&refresh=1m',{waitUntil:'domcontentloaded'});
  await page.getByText('Local learning lab · synthetic users only',{exact:true}).first().waitFor({timeout:60000});
  for(const name of ['Completed requests/s','HTTP p95','Application HTTP errors/s','Serving replicas / workers','Synthetic users','Durable ingestion state','Catalog products','Admitted responses / budget','Admission rejections/s']){
    const panel=page.getByRole('region',{name,exact:true});await panel.scrollIntoViewIfNeeded();
    await panel.locator('canvas').first().waitFor({timeout:60000});
    assert.ok(!(await panel.innerText()).includes('No data'),`${name} has no measured series`);
  }
  assert.ok(queries.some(status=>status===200),'No successful real datasource query');
  assert.deepEqual(errors,[],'Browser errors');
  await page.getByRole('region',{name:'Completed requests/s',exact:true}).scrollIntoViewIfNeeded();
  await page.screenshot({path:'/results/learning-dashboard.png',fullPage:true});
  Object.assign(report,{passed:true,url:'http://127.0.0.1:13004/d/local-learning-lab',datasourceResponses:queries,browserErrors:errors,screenshot:'learning-dashboard.png'});
  console.log('LEARNING_GRAFANA_BROWSER_PASS');
}catch(error){report.error=error.message;await page.screenshot({path:'/results/learning-dashboard-failure.png',fullPage:true});throw error;}
finally{report.finishedAt=new Date().toISOString();await writeFile('/results/learning-browser.json',JSON.stringify(report,null,2)+'\n');await browser.close();}
