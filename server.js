const express = require('express');
const WebSocket = require('ws');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const app = express();
const port = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Configuration Google Sheets
const GOOGLE_SHEET_ID = '1qr1nMXsG5BQvEFisli3qnKCbFiXX0xK6EWXhGZ1hbxM';
const serviceAccountAuth = new JWT({
  email: 'smart-ai-partners@test-b8502.iam.gserviceaccount.com',
  key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

// Configuration ElevenLabs
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL';

// Fonction pour ajouter une réservation
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
    
    console.log('Réservation ajoutée au Google Sheet');
    return { success: true };
  } catch (error) {
    console.error('Erreur Google Sheets:', error);
    return { success: false, error: error.message };
  }
}

app.get('/', (req, res) => {
  res.send('Server running');
});

app.post('/voice', (req, res) => {
  console.log('Appel reçu');
  res.type('text/xml');
  res.send(`
    <Response>
      <Connect>
        <Stream url="wss://${req.get('host')}/media-stream" />
      </Connect>
    </Response>
  `);
});

const server = require('http').createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  console.log('WebSocket Twilio connecté');
  
  let elevenLabsWs = null;
  let isUserSpeaking = false;
  let lastInterruptTime = 0;
  
  // Fonction pour créer une connexion ElevenLabs WebSocket
  function connectElevenLabs() {
    elevenLabsWs = new WebSocket('wss://api.elevenlabs.io/v1/text-to-speech/' + ELEVENLABS_VOICE_ID + '/stream-input?model_id=eleven_flash_v2&output_format=ulaw_8000&optimize_streaming_latency=4&stability=0.3', {
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY
      }
    });
    
    elevenLabsWs.on('open', () => {
      console.log('ElevenLabs WebSocket connecté');
      
      // Configuration pour latence minimale
      elevenLabsWs.send(JSON.stringify({
        text: " ",
        voice_settings: {
          stability: 0.3,
          similarity_boost: 0.8,
          style: 0.0,
          use_speaker_boost: true
        },
        generation_config: {
          chunk_length_schedule: [50]
        }
      }));
    });
    
    elevenLabsWs.on('message', (data) => {
      const response = JSON.parse(data);
      
      if (response.audio && !isUserSpeaking) {
        // Envoyer seulement si l'utilisateur ne parle pas
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
      console.error('Erreur ElevenLabs WebSocket:', error);
    });
    
    elevenLabsWs.on('close', () => {
      console.log('ElevenLabs WebSocket fermé');
    });
  }
  
  // Connexion à OpenAI Realtime
  const openaiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview', {
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'OpenAI-Beta': 'realtime=v1'
    }
  });

  openaiWs.on('open', () => {
    console.log('OpenAI Realtime connecté');
    
    // Créer la connexion ElevenLabs
    connectElevenLabs();
    
    // Configuration de la session
    openaiWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        modalities: ['text'],
        instructions: 'You are the reservation assistant for Casa Masa restaurant. Collect ALL required information BEFORE calling the function tool. Required: date, time, number of guests, name, phone, email. ONLY call make_reservation when you have ALL these details confirmed. Keep responses VERY SHORT and conversational. Be natural and human-like. Never repeat yourself.',
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
            required: ['reservation_date', 'guests_count', 'customer_name', 'phone_number']
          }
        }]
      }
    }));
    
    // Message d'accueil - une seule fois
    setTimeout(() => {
      if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
        // Créer le message via OpenAI pour qu'il soit dans la conversation
        openaiWs.send(JSON.stringify({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'assistant',
            content: [{
              type: 'text',
              text: 'Hello! Welcome to Casa Masa, thank you for calling. What brings you in today?'
            }]
          }
        }));
        
        openaiWs.send(JSON.stringify({
          type: 'response.create'
        }));
      }
    }, 500);
  });

  let textBuffer = '';
  let responseId = null;
  
  openaiWs.on('message', async (data) => {
    try {
      const response = JSON.parse(data);
      
      // Détection de parole utilisateur pour interruption
      if (response.type === 'input_audio_buffer.speech_started') {
        console.log('Utilisateur commence à parler - interruption');
        isUserSpeaking = true;
        lastInterruptTime = Date.now();
        
        // Interrompre la génération OpenAI seulement s'il y a une réponse en cours
        if (responseId) {
          openaiWs.send(JSON.stringify({
            type: 'response.cancel'
          }));
          responseId = null;
        }
        
        // Clear audio Twilio
        ws.send(JSON.stringify({
          event: 'clear'
        }));
        
        textBuffer = '';
      }
      
      if (response.type === 'input_audio_buffer.speech_stopped') {
        isUserSpeaking = false;
      }
      
      // Capturer l'ID de réponse pour pouvoir l'annuler
      if (response.type === 'response.created') {
        responseId = response.response.id;
      }
      
      // Streaming du texte - toujours envoyer, OpenAI gère l'interruption
      if (response.type === 'response.text.delta' && response.delta) {
        textBuffer += response.delta;
        
        // Envoyer immédiatement par petits chunks
        if (textBuffer.length > 10) {
          if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
            elevenLabsWs.send(JSON.stringify({
              text: textBuffer,
              flush: false
            }));
            textBuffer = '';
          }
        }
      }
      
      // Fin de réponse
      if (response.type === 'response.done') {
        responseId = null;
        if (textBuffer.trim() && elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
          elevenLabsWs.send(JSON.stringify({
            text: textBuffer,
            flush: true
          }));
          textBuffer = '';
        }
      }
      
      if (response.type === 'response.function_call_arguments.done') {
        console.log('Function call:', response.name, response.arguments);
        
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
      console.error('Erreur OpenAI message:', error);
    }
  });

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      if (data.event === 'start') {
        console.log('Stream Twilio démarré');
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
        console.log('Stream arrêté');
        if (openaiWs.readyState === WebSocket.OPEN) {
          openaiWs.close();
        }
        if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
          elevenLabsWs.close();
        }
      }
      
    } catch (error) {
      console.error('Erreur Twilio message:', error);
    }
  });
  
  ws.on('close', () => {
    console.log('WebSocket Twilio fermé');
    if (openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.close();
    }
    if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
      elevenLabsWs.close();
    }
  });

  openaiWs.on('close', () => {
    console.log('OpenAI WebSocket fermé');
  });

  openaiWs.on('error', (error) => {
    console.error('Erreur OpenAI WebSocket:', error);
  });
});

server.listen(port, () => {
  console.log(`Server started on port ${port}`);
  console.log('WebSocket on port', port);
});