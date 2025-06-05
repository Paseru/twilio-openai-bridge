// ------------------------------------------------------------
//  Casa Masa realtime voice-bot — version optimisée
//  Stack : Twilio Media Streams ↔ OpenAI Realtime ↔ ElevenLabs
//  Persistance : Google Sheets
// ------------------------------------------------------------

require('dotenv').config();
const express = require('express');
const WebSocket = require('ws');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const http = require('http');

const app = express();
const port = process.env.PORT || 3000;
const TWILIO_REGION = process.env.TWILIO_REGION || 'ie1';

// ------------------------------------------------------------
//  CONFIGURATION
// ------------------------------------------------------------
const GOOGLE_SHEET_ID = '1qr1nMXsG5BQvEFisli3qnKCbFiXX0xK6EWXhGZ1hbxM';
const serviceAccountAuth = new JWT({
  email: 'smart-ai-partners@test-b8502.iam.gserviceaccount.com',
  key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL';

// ------------------------------------------------------------
//  GOOGLE SHEETS FUNCTIONS
// ------------------------------------------------------------
async function addReservation(reservationData) {
  try {
    const doc = new GoogleSpreadsheet(GOOGLE_SHEET_ID, serviceAccountAuth);
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    
    await sheet.addRow({
      Date: reservationData.reservation_date,
      Guests: reservationData.guests_count,
      Name: reservationData.contact_info.name,
      Phone: reservationData.contact_info.phone,
      Email: reservationData.contact_info.email || ''
    });
    
    console.log('✅ Réservation ajoutée au Google Sheet');
    return { success: true };
  } catch (error) {
    console.error('🛑 Erreur Google Sheets:', error);
    return { success: false, error: error.message };
  }
}

// ------------------------------------------------------------
//  EXPRESS ROUTES
// ------------------------------------------------------------
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.get('/', (req, res) => {
  res.send('Server running');
});

app.post('/voice', (req, res) => {
  console.log('📞 Appel reçu');
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

// ------------------------------------------------------------
//  SERVER + WEBSOCKET
// ------------------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  console.log('🔗 WebSocket Twilio connecté');
  
  let elevenLabsWs = null;
  let isUserSpeaking = false;
  let currentResponseId = null;
  let textBuffer = '';
  
  // ------------------------------------------------------------
  //  ELEVENLABS WEBSOCKET (connexion persistante)
  // ------------------------------------------------------------
  function connectElevenLabs() {
    elevenLabsWs = new WebSocket(
      `wss://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream-input?model_id=eleven_flash_v2&output_format=ulaw_8000&optimize_streaming_latency=4`,
      { headers: { 'xi-api-key': ELEVENLABS_API_KEY } }
    );
    
    elevenLabsWs.on('open', () => {
      console.log('🔊 ElevenLabs WebSocket connecté');
      
      // Configuration initiale optimisée
      elevenLabsWs.send(JSON.stringify({
        text: " ",
        voice_settings: {
          stability: 0.3,
          similarity_boost: 0.8,
          style: 0.0,
          use_speaker_boost: true,
          speed: 1.1  // +10% vitesse pour réduire la latence
        },
        generation_config: {
          chunk_length_schedule: [50]
        }
      }));
    });
    
    elevenLabsWs.on('message', (data) => {
      const response = JSON.parse(data);
      
      // Envoyer audio à Twilio seulement si l'utilisateur ne parle pas
      if (response.audio && !isUserSpeaking) {
        ws.send(JSON.stringify({
          event: 'media',
          streamSid: ws.streamSid,
          media: {
            payload: response.audio
          }
        }));
      }
    });
    
    elevenLabsWs.on('error', (error) => {
      console.error('🛑 Erreur ElevenLabs WebSocket:', error);
    });
    
    elevenLabsWs.on('close', () => {
      console.log('🔌 ElevenLabs WebSocket fermé');
    });
  }
  
  // ------------------------------------------------------------
  //  OPENAI REALTIME WEBSOCKET
  // ------------------------------------------------------------
  const openaiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview', {
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'OpenAI-Beta': 'realtime=v1'
    }
  });

  openaiWs.on('open', () => {
    console.log('🤖 OpenAI Realtime connecté');
    
    // Créer la connexion ElevenLabs
    connectElevenLabs();
    
    // Configuration de la session optimisée
    openaiWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        modalities: ['text'], // Uniquement le texte en sortie
        instructions: `ALWAYS USE THE TOOL FUNCTION. You are the reservation assistant for Casa Masa restaurant. Start with: "Hello! Welcome to Casa Masa, thank you for calling. What brings you in today?" Then collect ALL required information BEFORE calling the function tool. Required: date, time, number of guests, name, phone, email. ONLY call make_reservation when you have ALL these details confirmed. You are a highly responsive, real-time vocal AI assistant specialized in handling restaurant reservations over the phone. Your default language is fluent, conversational English, but you seamlessly detect and switch to any other language spoken by the caller.

Your communication style is extremely natural, fast-paced, and human-like. Keep responses brief and conversational. When collecting information:
- Confirm details clearly: "So that's a table for four people tomorrow evening at 7 PM, is that right?"
- Offer alternatives if needed: "I'm sorry, we don't have availability at 7 PM, but we could offer you 7:30 PM or 6:30 PM."
- Collect contact info: "Could I have your name and contact number to finalize your reservation?"
- Summarize before confirming: "Just to recap, you have a reservation under John Smith for four people tomorrow at 7:30 PM. Everything correct?"

Be warm, efficient, and professional throughout.`,
        input_audio_format: 'g711_ulaw',
        input_audio_transcription: {
          model: 'whisper-1'
        },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 200
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
                description: 'Date and time in ISO format (YYYY-MM-DDTHH:MM:SS)'
              },
              guests_count: {
                type: 'number',
                description: 'Number of guests'
              },
              contact_info: {
                type: 'object',
                properties: {
                  name: {
                    type: 'string',
                    description: 'Customer name'
                  },
                  phone: {
                    type: 'string',
                    description: 'Phone number'
                  },
                  email: {
                    type: 'string',
                    description: 'Email address'
                  }
                }
              }
            },
            required: ['reservation_date', 'guests_count', 'contact_info']
          }
        }]
      }
    }));
    
    // Message d'accueil déclenché une seule fois
    setTimeout(() => {
      openaiWs.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello! Welcome to Casa Masa, thank you for calling. What brings you in today?' }]
        }
      }));
      openaiWs.send(JSON.stringify({ type: 'response.create' }));
    }, 300);
  });

  // ------------------------------------------------------------
  //  GESTION DES MESSAGES OPENAI
  // ------------------------------------------------------------
  openaiWs.on('message', async (data) => {
    try {
      const response = JSON.parse(data);
      
      // Détection début de parole utilisateur (barge-in)
      if (response.type === 'input_audio_buffer.speech_started') {
        isUserSpeaking = true;
        if (currentResponseId) {
          openaiWs.send(JSON.stringify({ type: 'response.cancel' }));
          currentResponseId = null;
        }
        // Arrêter la génération ElevenLabs sans fermer la connexion
        if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
          elevenLabsWs.send(JSON.stringify({ stop: true }));
        }
        textBuffer = ''; // Vider le buffer
        return;
      }
      
      // Fin de parole utilisateur
      if (response.type === 'input_audio_buffer.speech_stopped') {
        setTimeout(() => { isUserSpeaking = false; }, 100);
        return;
      }
      
      // Capture de l'ID de réponse pour annulation
      if (response.type === 'response.created') {
        currentResponseId = response.response.id;
        return;
      }
      
      // Streaming du texte vers ElevenLabs
      if (response.type === 'response.text.delta' && response.delta) {
        if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
          elevenLabsWs.send(JSON.stringify({
            text: response.delta,
            flush: false
          }));
        }
      }
      
      // Fin de la réponse
      if (response.type === 'response.done') {
        currentResponseId = null;
        if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
          // Force flush pour démarrer la parole immédiatement
          elevenLabsWs.send(JSON.stringify({ text: '', flush: true }));
        }
      }
      
      // Gestion des appels de fonction
      if (response.type === 'response.function_call_arguments.done') {
        console.log('📋 Function call:', response.name, response.arguments);
        
        if (response.name === 'make_reservation') {
          const args = JSON.parse(response.arguments);
          const result = await addReservation(args);
          
          openaiWs.send(JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'function_call_output',
              call_id: response.call_id,
              output: JSON.stringify(result)
            }
          }));
          
          openaiWs.send(JSON.stringify({
            type: 'response.create'
          }));
        }
      }
      
    } catch (error) {
      console.error('🛑 Erreur OpenAI message:', error);
    }
  });

  // ------------------------------------------------------------
  //  GESTION DES MESSAGES TWILIO
  // ------------------------------------------------------------
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      if (data.event === 'start') {
        console.log('▶️ Stream Twilio démarré');
        ws.streamSid = data.start.streamSid;
      }
      
      if (data.event === 'media') {
        if (openaiWs.readyState === WebSocket.OPEN) {
          openaiWs.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: data.media.payload
          }));
        }
      }
      
      if (data.event === 'stop') {
        console.log('⛔ Stream arrêté');
        if (openaiWs.readyState === WebSocket.OPEN) {
          openaiWs.close();
        }
        if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
          elevenLabsWs.close();
        }
      }
      
    } catch (error) {
      console.error('🛑 Erreur Twilio message:', error);
    }
  });
  
  // ------------------------------------------------------------
  //  NETTOYAGE DES CONNEXIONS
  // ------------------------------------------------------------
  const safeClose = (ws) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.close();
  };
  
  ws.on('close', () => {
    console.log('🔌 WebSocket Twilio fermé');
    safeClose(openaiWs);
    safeClose(elevenLabsWs);
  });

  openaiWs.on('close', () => {
    console.log('🔌 OpenAI WebSocket fermé');
  });

  openaiWs.on('error', (error) => {
    console.error('🛑 Erreur OpenAI WebSocket:', error);
  });
});

// ------------------------------------------------------------
//  DÉMARRAGE DU SERVEUR
// ------------------------------------------------------------
server.listen(port, () => {
  console.log(`🚀 Server démarré sur le port ${port}`);
  console.log(`📡 WebSocket disponible sur le port ${port}`);
});