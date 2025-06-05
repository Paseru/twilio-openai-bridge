// ------------------------------------------------------------
//  Casa Masa realtime voice‑bot — ultra‑low‑latency version
//  Stack : Twilio Media Streams ↔ OpenAI Realtime (gpt‑4.1‑nano)
//          ↔ ElevenLabs streaming TTS  ↔ Twilio RTP
//  Persistance   : Google Sheets
// ------------------------------------------------------------

require('dotenv').config();
const express            = require('express');
const WebSocket          = require('ws');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT }            = require('google-auth-library');
const http               = require('http');

const app  = express();
const port = process.env.PORT || 3000;
const TWILIO_REGION = process.env.TWILIO_REGION || 'ie1';          // proche du PoP Twilio

//--------------------------------------------------------------
//  GOOGLE SHEETS SETUP
//--------------------------------------------------------------
const GOOGLE_SHEET_ID = '1qr1nMXsG5BQvEFisli3qnKCbFiXX0xK6EWXhGZ1hbxM';
const serviceAccountAuth = new JWT({
  email: 'smart-ai-partners@test-b8502.iam.gserviceaccount.com',
  key:   process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

async function addReservation (data) {
  try {
    const doc = new GoogleSpreadsheet(GOOGLE_SHEET_ID, serviceAccountAuth);
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    await sheet.addRow({
      Date:   data.reservation_date,
      Guests: data.guests_count,
      Name:   data.contact_info.name,
      Phone:  data.contact_info.phone,
      Email:  data.contact_info.email || ''
    });
    console.log('✅  Reservation saved to Google Sheets');
    return { success: true };
  } catch (err) {
    console.error('🛑  Google Sheets error', err);
    return { success: false, error: err.message };
  }
}

//--------------------------------------------------------------
//  EXPRESS + TwiML ENDPOINTS
//--------------------------------------------------------------
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.get('/', (_, res) => res.send('Server running'));

app.post('/voice', (req, res) => {
  console.log('📞  Incoming call');
  res.type('text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${req.get('host')}/media-stream">
      <Parameter name="Twilio-Region" value="${TWILIO_REGION}" />
    </Stream>
  </Connect>
</Response>`);
});

//--------------------------------------------------------------
//  SERVER + WS HUB
//--------------------------------------------------------------
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

wss.on('connection', (clientWs) => {
  console.log('🔗  Twilio WebSocket connected');
  let isUserSpeaking = false;
  let currentResponseId = null;

  //----------------------------------------------------------
  //  ELEVENLABS WS (kept open for the whole call)
  //----------------------------------------------------------
  const elevenLabsWs = new WebSocket(
    `wss://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL'}/stream-input?model_id=eleven_flash_v2&output_format=ulaw_8000&optimize_streaming_latency=4`,
    { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY } }
  );

  elevenLabsWs.on('open', () => {
    console.log('🔊  ElevenLabs WS ready');
    elevenLabsWs.send(JSON.stringify({
      text: ' ', // prime the stream (low‑latency hack)
      voice_settings: {
        stability: 0.3,
        similarity_boost: 0.8,
        style: 0.0,
        use_speaker_boost: true,
        speed: 1.1               // +10 % speed ↘ durée
      }
    }));
  });

  // pipe TTS packets to Twilio when caller is silent
  elevenLabsWs.on('message', (data) => {
    const msg = JSON.parse(data);
    if (msg.audio && !isUserSpeaking) {
      clientWs.send(JSON.stringify({
        event:      'media',
        streamSid:  clientWs.streamSid,
        media: { payload: msg.audio }
      }));
    }
  });

  //----------------------------------------------------------
  //  OPENAI REALTIME WS
  //----------------------------------------------------------
  const openaiWs = new WebSocket(
    'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview',
    {
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'OpenAI-Beta':   'realtime=v1'
      }
    }
  );

  openaiWs.on('open', () => {
    console.log('🤖  OpenAI Realtime WS ready');

    // Session configuration
    openaiWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        modalities: ['text'],
        instructions: `You are the front desk assistant at Casa Masa restaurant. Greet guests warmly and naturally, like you're welcoming them at the entrance. Guide the conversation in a relaxed, friendly tone. Ask for details casually and conversationally — not like filling a form. Before calling any function, make sure you’ve gently collected and confirmed all the following: – date – time – number of guests – name – phone number – email address Don’t rush. Let it feel like a real conversation. Only once everything is clear and confirmed, call make_reservation. Keep each response brief, warm, and human — like a host chatting with someone at the front desk.`,
        input_audio_format:        'g711_ulaw',
        input_audio_transcription: { model: 'whisper-1' },
        turn_detection: {
          type: 'server_vad', threshold: 0.5,
          prefix_padding_ms: 300, silence_duration_ms: 200
        },
        tools: [{
          type: 'function',
          name: 'make_reservation',
          description: 'Book restaurant reservation with complete details',
          parameters: {
            type: 'object',
            properties: {
              reservation_date: {
                type: 'string',
                description: 'Date and time ISO (YYYY-MM-DDTHH:MM)'
              },
              guests_count: { type: 'number' },
              contact_info: {
                type: 'object',
                properties: {
                  name:  { type: 'string' },
                  phone: { type: 'string' },
                  email: { type: 'string' }
                }
              }
            },
            required: ['reservation_date', 'guests_count', 'contact_info']
          }
        }]
      }
    }));

    // Greeting (sent once, triggers response cycle)
    setTimeout(() => {
      openaiWs.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type:    'message',
          role:    'assistant',
          content: [{ type: 'text', text: 'Hello ?' }]
        }
      }));
      openaiWs.send(JSON.stringify({ type: 'response.create' }));
    }, 300);
  });

  //----------------------------------------------------------
  //  OPENAI MESSAGE HANDLER
  //----------------------------------------------------------
  openaiWs.on('message', async (data) => {
    const msg = JSON.parse(data);

    //------ Caller starts talking (barge‑in) -----------------
    if (msg.type === 'input_audio_buffer.speech_started') {
      isUserSpeaking = true;
      if (currentResponseId) {
        openaiWs.send(JSON.stringify({ type: 'response.cancel' }));
        currentResponseId = null;
      }
      // Ask ElevenLabs to stop generation without closing WS
      if (elevenLabsWs.readyState === WebSocket.OPEN) {
        elevenLabsWs.send(JSON.stringify({ stop: true }));
      }
      return; // nothing else to process
    }

    //------ Caller has stopped talking -----------------------
    if (msg.type === 'input_audio_buffer.speech_stopped') {
      // small grace period before re‑enabling playback
      setTimeout(() => { isUserSpeaking = false; }, 100);
      return;
    }

    //------ Capture response ID for cancellation -------------
    if (msg.type === 'response.created') {
      currentResponseId = msg.response.id;
      return;
    }

    //------ Stream text deltas  -> ElevenLabs ----------------
    if (msg.type === 'response.text.delta' && msg.delta) {
      if (elevenLabsWs.readyState === WebSocket.OPEN) {
        elevenLabsWs.send(JSON.stringify({ text: msg.delta, flush: false }));
      }
      return;
    }

    //------ End of assistant turn ----------------------------
    if (msg.type === 'response.done') {
      currentResponseId = null;
      if (elevenLabsWs.readyState === WebSocket.OPEN) {
        // force flush so ElevenLabs starts speaking immediately
        elevenLabsWs.send(JSON.stringify({ text: '', flush: true }));
      }
      return;
    }

    //------ Function call complete ---------------------------
    if (msg.type === 'response.function_call_arguments.done' && msg.name === 'make_reservation') {
      const args = JSON.parse(msg.arguments);
      const result = await addReservation(args);

      openaiWs.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: msg.call_id,
          output: JSON.stringify(result)
        }
      }));
      openaiWs.send(JSON.stringify({ type: 'response.create' }));
    }
  });

  //----------------------------------------------------------
  //  TWILIO MEDIA STREAM HANDLER
  //----------------------------------------------------------
  clientWs.on('message', (raw) => {
    const pkt = JSON.parse(raw);

    if (pkt.event === 'start') {
      clientWs.streamSid = pkt.start.streamSid;
      console.log('▶️  Twilio stream started', clientWs.streamSid);
    }

    if (pkt.event === 'media') {
      if (openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: pkt.media.payload
        }));
      }
    }

    if (pkt.event === 'stop') {
      console.log('⛔️  Twilio stream stopped');
      if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
      if (elevenLabsWs.readyState === WebSocket.OPEN) elevenLabsWs.close();
    }
  });

  //----------------------------------------------------------
  //  CLEANUP
  //----------------------------------------------------------
  const safeClose = (ws) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.close();
  };

  clientWs.on('close', () => {
    console.log('🔌  Twilio WS closed');
    safeClose(openaiWs);
    safeClose(elevenLabsWs);
  });

  openaiWs.on('close', () => console.log('🔌  OpenAI WS closed'));
  openaiWs.on('error', (e) => console.error('🛑  OpenAI WS error', e));
  elevenLabsWs.on('error', (e) => console.error('🛑  ElevenLabs WS error', e));
});

//--------------------------------------------------------------
server.listen(port, () => {
  console.log(`🚀  Server listening on port ${port}`);
});
