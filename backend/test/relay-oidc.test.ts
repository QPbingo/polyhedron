import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {generateKeyPair,exportJWK,SignJWT} from 'jose';
import {createRelay} from '../src/relay/app.js';

// Only the external identity-provider HTTP boundary is simulated. Discovery,
// code exchange, PKCE, JWT signatures, state and nonce checks use openid-client.
test('OIDC validates PKCE, state, nonce, ID-token signature and one-use login flow',async()=>{
  const issuer='https://identity.example',origin='http://127.0.0.1:5174';
  const {publicKey,privateKey}=await generateKeyPair('RS256');
  const jwk={...await exportJWK(publicKey),kid:'test-key',alg:'RS256',use:'sig'};
  let authorization:URL,invalidNonce=false,invalidSignature=false,tokenCalls=0;
  const savedFetch=globalThis.fetch;
  globalThis.fetch=async(input,init)=>{
    const url=String(input);
    if(url===`${issuer}/.well-known/openid-configuration`)return Response.json({issuer,authorization_endpoint:`${issuer}/authorize`,token_endpoint:`${issuer}/token`,jwks_uri:`${issuer}/jwks`,response_types_supported:['code'],subject_types_supported:['public'],id_token_signing_alg_values_supported:['RS256'],code_challenge_methods_supported:['S256']});
    if(url===`${issuer}/jwks`)return Response.json({keys:[jwk]});
    if(url===`${issuer}/token`){
      tokenCalls++;const body=new URLSearchParams(String(init?.body));
      assert.equal(body.get('grant_type'),'authorization_code');
      assert.equal(body.get('redirect_uri'),`${origin}/auth/callback`);
      const verifier=body.get('code_verifier');assert.ok(verifier);
      assert.equal(createHash('sha256').update(verifier).digest('base64url'),authorization.searchParams.get('code_challenge'));
      let jwt=await new SignJWT({nonce:invalidNonce?'wrong':authorization.searchParams.get('nonce'),name:'OIDC Alice'}).setSubject('alice').setIssuer(issuer).setAudience('client-one').setIssuedAt().setExpirationTime('5m').setProtectedHeader({alg:'RS256',kid:'test-key'}).sign(privateKey);
      if(invalidSignature){const chunks=jwt.split('.');chunks[2]=Buffer.alloc(256,1).toString('base64url');jwt=chunks.join('.');}
      return Response.json({access_token:'provider-access-token',token_type:'Bearer',expires_in:300,id_token:jwt});
    }
    throw new Error(`Unexpected identity-provider request: ${url}`);
  };
  let app:Awaited<ReturnType<typeof createRelay>>|undefined;
  try{
    app=await createRelay({devAuth:true,bindHost:'127.0.0.1',publicOrigin:origin,sessionSecret:'test-oidc-session-secret-more-than-32-characters',databasePath:':memory:',oidc:{issuer,clientId:'client-one',clientSecret:'provider-client-secret'}});
    async function begin(){const response=await app!.inject({url:'/auth/login'});assert.equal(response.statusCode,302);authorization=new URL(response.headers.location!);assert.equal(authorization.searchParams.get('code_challenge_method'),'S256');assert.ok(authorization.searchParams.get('nonce'));assert.ok(authorization.searchParams.get('state'));return {cookie:String(response.headers['set-cookie']).split(';')[0],state:authorization.searchParams.get('state')!};}
    const login=await begin();
    const good=await app.inject({url:`/auth/callback?code=code-one&state=${login.state}`,headers:{cookie:login.cookie}});assert.equal(good.statusCode,302,good.body);assert.equal(good.headers.location,'/');
    const cookie=String(good.headers['set-cookie']);assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Lax/);
    const sessionCookie=(good.cookies.find(c=>c.name==='polyhedron_session'))!;
    const auth=await app.inject({url:'/api/auth',headers:{cookie:`${sessionCookie.name}=${sessionCookie.value}`}});assert.equal(auth.json().user.name,'OIDC Alice');
    assert.equal((await app.inject({url:`/auth/callback?code=code-one&state=${login.state}`,headers:{cookie:login.cookie}})).statusCode,401);
    const mismatch=await begin(),before=tokenCalls;
    assert.equal((await app.inject({url:'/auth/callback?code=another&state=attacker-state',headers:{cookie:mismatch.cookie}})).statusCode,401);assert.equal(tokenCalls,before);
    assert.equal((await app.inject({url:'/auth/callback?code=another&state=no-cookie'})).statusCode,401);
    invalidNonce=true;const nonce=await begin();assert.equal((await app.inject({url:`/auth/callback?code=nonce&state=${nonce.state}`,headers:{cookie:nonce.cookie}})).statusCode,401);
    invalidNonce=false;invalidSignature=true;const signature=await begin();assert.equal((await app.inject({url:`/auth/callback?code=signature&state=${signature.state}`,headers:{cookie:signature.cookie}})).statusCode,401);
  }finally{globalThis.fetch=savedFetch;await app?.close();}
});
