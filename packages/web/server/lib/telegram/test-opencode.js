import { createOpencodeClient } from '@opencode-ai/sdk';
import process from 'process';

async function test() {
  const client = createOpencodeClient({ baseUrl: 'http://localhost:3000' });
  const session = await client.session.create({ title: 'Test Session', directory: process.cwd() });
  console.log('Session created:', session.id);

  console.log('Prompting...');
  const promptBody = { parts: [{ type: 'text', text: 'say hello' }] };
  const promptRes = await fetch(`http://localhost:3000/session/${encodeURIComponent(session.id)}/prompt_async`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'accept': 'application/json' },
    body: JSON.stringify(promptBody)
  });
  console.log('prompt_async ok:', promptRes.ok);
  if (!promptRes.ok) {
    console.log(await promptRes.text());
  }

  for (let i = 0; i < 5; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
        const statusRes = await fetch(`http://localhost:3000/session/status`);
        const statusData = await statusRes.json();
        console.log('Status entry:', statusData[session.id] || 'missing');
        
        const msgsRes = await fetch(`http://localhost:3000/session/${encodeURIComponent(session.id)}/message?limit=3`);
        const msgs = await msgsRes.json();
        if (msgs && msgs.length > 0) {
            const assistantMsg = msgs.find(m => m.info && m.info.role === 'assistant');
            if (assistantMsg) {
                console.log('Latest msg parts:', assistantMsg.parts.length, assistantMsg.parts[0]?.type);
            } else {
                console.log('No assistant message');
            }
        }
    } catch (err) {
        console.error("fetch failed", err);
    }
  }
}

test().catch(console.error);
