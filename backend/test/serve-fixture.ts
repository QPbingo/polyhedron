import {createFixture} from './fixtures/setup.js';
const fixture=await createFixture(Number(process.env.FIXTURE_PORT??13001),process.env.PUBLIC_ORIGIN??'http://127.0.0.1:15174');
console.log(JSON.stringify({port:fixture.port,project:fixture.project,session:fixture.session,root:fixture.root}));
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>void fixture.close().then(()=>process.exit(0)));
