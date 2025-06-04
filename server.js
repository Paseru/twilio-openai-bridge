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
  let audioQueue = [];
  let isPlaying = false;
  
  // Fonction pour créer une connexion ElevenLabs WebSocket
  function connectElevenLabs() {
    elevenLabsWs = new WebSocket('wss://api.elevenlabs.io/v1/text-to-speech/' + ELEVENLABS_VOICE_ID + '/stream-input?model_id=eleven_flash_v2&output_format=ulaw_8000', {
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY
      }
    });
    
    elevenLabsWs.on('open', () => {
      console.log('ElevenLabs WebSocket connecté');
      
      // Configuration initiale
      elevenLabsWs.send(JSON.stringify({
        text: " ",
        voice_settings: {
          stability: 0.5,
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
      
      if (response.audio) {
        // Envoyer directement à Twilio (déjà en ulaw)
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
    
    // Configuration de la session - DÉSACTIVER l'audio output d'OpenAI
    openaiWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        modalities: ['text'], // Uniquement le texte en sortie
        instructions: 'ALWAYS USE THE TOOL FUNCTION. You are the reservation assistant for Casa Masa restaurant. Start with: "Hello! Welcome to Casa Masa, thank you for calling. What brings you in today?" Then collect ALL required information BEFORE calling the function tool. Required: date, time, number of guests, name, phone, email. ONLY call make_reservation when you have ALL these details confirmed. You are a highly responsive, real-time vocal AI assistant specialized in handling restaurant reservations over the phone. Your default language is fluent, conversational English, but you seamlessly detect and switch to any other language spoken by the caller.\n\nYour communication style is extremely natural, fast-paced, and human-like. You maintain a friendly and helpful tone, ensuring interactions feel genuine, reassuring, and engaging. Your speech is informal yet professional, casual but polite, precisely imitating the ease and fluidity of human conversation.\n\nWhen a caller initiates a reservation:\n\n1. Greet them warmly and confirm the purpose of their call:\n   - "Good evening, thank you for calling! Would you like to book a table today?"\n\n2. Clearly identify and confirm critical reservation details (date, time, number of guests):\n   - "Great! For how many guests, please?"\n   - "Perfect, and for which date?"\n   - "Excellent, at what time would you prefer?"\n   - Always clearly confirm back: "So that\'s a table for four people tomorrow evening at 7 PM, is that right?"\n\n3. Offer alternatives if the requested time isn\'t available:\n   - "I\'m sorry, we don\'t have availability at 7 PM, but we could offer you 7:30 PM or perhaps earlier at 6:30 PM. Would either of those work for you?"\n\n4. Collect additional information when necessary:\n   - Special requests (seating preferences, dietary needs): "Do you have any special seating requests or dietary preferences we should know about?"\n   - Occasion: "Is there a special occasion you\'d like us to know about, like a birthday or anniversary?"\n\n5. Confirm contact information:\n   - "Could I have your name and contact number to finalize your reservation, please?"\n\n6. Summarize the entire reservation clearly and succinctly:\n   - "Just to recap, you have a reservation under the name John Smith for four people tomorrow evening at 7:30 PM. Everything correct?"\n\n7. Politely conclude and thank them warmly:\n   - "Fantastic, your reservation is confirmed! We\'re looking forward to welcoming you. Have a wonderful day!"\n\nThroughout the interaction, ensure:\n- Responses are immediate, minimizing any noticeable delay.\n- Tone remains reassuring and attentive, actively acknowledging all details provided by the caller.\n- If you detect a language other than English, smoothly transition to that language without interruption.\n- Maintain an engaging, conversational pace, proactively clarifying and confirming details to avoid misunderstandings.',
        input_audio_format: 'g711_ulaw',
        input_audio_transcription: {
          model: 'whisper-1'
        },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.1,
          prefix_padding_ms: 100,
          silence_duration_ms: 300
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
    
    // Message d'accueil avec ElevenLabs WebSocket
    setTimeout(() => {
      if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
        elevenLabsWs.send(JSON.stringify({
          text: "Hello! Welcome to Casa Masa, thank you for calling. What brings you in today?",
          flush: true
        }));
      }
    }, 1000);
  });

  let textBuffer = '';
  
  openaiWs.on('message', async (data) => {
    try {
      const response = JSON.parse(data);
      
      // Capturer le texte en streaming
      if (response.type === 'response.text.delta' && response.delta) {
        textBuffer += response.delta;
        
        // Envoyer à ElevenLabs par chunks
        const chunks = textBuffer.match(/.{1,50}[.!?,\s]|.{1,50}$/g) || [];
        
        if (chunks.length > 1) {
          const chunkToSend = chunks[0];
          textBuffer = textBuffer.substring(chunkToSend.length);
          
          if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
            elevenLabsWs.send(JSON.stringify({
              text: chunkToSend,
              flush: false
            }));
          }
        }
      }
      
      // Fin de la réponse - envoyer le reste
      if (response.type === 'response.done') {
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