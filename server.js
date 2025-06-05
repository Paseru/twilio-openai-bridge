const express = require('express');
const WebSocket = require('ws');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');
const path = require('path');
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

// Configuration ElevenLabs - Optimisée pour la latence
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL';

// Configuration son d'ambiance
const BACKGROUND_SOUND_PATH = process.env.BACKGROUND_SOUND_PATH || './restaurant-ambiance.raw';
const BACKGROUND_VOLUME = parseFloat(process.env.BACKGROUND_VOLUME || '0.08'); // Réduit le volume

// Tables de conversion µ-law
const ULAW_DECODE_TABLE = new Int16Array([
  -32124, -31100, -30076, -29052, -28028, -27004, -25980, -24956,
  -23932, -22908, -21884, -20860, -19836, -18812, -17788, -16764,
  -15996, -15484, -14972, -14460, -13948, -13436, -12924, -12412,
  -11900, -11388, -10876, -10364, -9852, -9340, -8828, -8316,
  -7932, -7676, -7420, -7164, -6908, -6652, -6396, -6140,
  -5884, -5628, -5372, -5116, -4860, -4604, -4348, -4092,
  -3900, -3772, -3644, -3516, -3388, -3260, -3132, -3004,
  -2876, -2748, -2620, -2492, -2364, -2236, -2108, -1980,
  -1884, -1820, -1756, -1692, -1628, -1564, -1500, -1436,
  -1372, -1308, -1244, -1180, -1116, -1052, -988, -924,
  -876, -844, -812, -780, -748, -716, -684, -652,
  -620, -588, -556, -524, -492, -460, -428, -396,
  -372, -356, -340, -324, -308, -292, -276, -260,
  -244, -228, -212, -196, -180, -164, -148, -132,
  -120, -112, -104, -96, -88, -80, -72, -64,
  -56, -48, -40, -32, -24, -16, -8, 0,
  32124, 31100, 30076, 29052, 28028, 27004, 25980, 24956,
  23932, 22908, 21884, 20860, 19836, 18812, 17788, 16764,
  15996, 15484, 14972, 14460, 13948, 13436, 12924, 12412,
  11900, 11388, 10876, 10364, 9852, 9340, 8828, 8316,
  7932, 7676, 7420, 7164, 6908, 6652, 6396, 6140,
  5884, 5628, 5372, 5116, 4860, 4604, 4348, 4092,
  3900, 3772, 3644, 3516, 3388, 3260, 3132, 3004,
  2876, 2748, 2620, 2492, 2364, 2236, 2108, 1980,
  1884, 1820, 1756, 1692, 1628, 1564, 1500, 1436,
  1372, 1308, 1244, 1180, 1116, 1052, 988, 924,
  876, 844, 812, 780, 748, 716, 684, 652,
  620, 588, 556, 524, 492, 460, 428, 396,
  372, 356, 340, 324, 308, 292, 276, 260,
  244, 228, 212, 196, 180, 164, 148, 132,
  120, 112, 104, 96, 88, 80, 72, 64,
  56, 48, 40, 32, 24, 16, 8, 0
]);

function ulaw2linear(ulawValue) {
  return ULAW_DECODE_TABLE[ulawValue & 0xFF];
}

function linear2ulaw(linearValue) {
  const BIAS = 0x84;
  const MAX = 32635;
  let sign = 0;
  
  if (linearValue < 0) {
    sign = 0x80;
    linearValue = -linearValue;
  }
  
  if (linearValue > MAX) linearValue = MAX;
  linearValue += BIAS;
  
  let exponent = 7;
  for (let expMask = 0x4000; (linearValue & expMask) === 0; exponent--, expMask >>= 1) {}
  
  const mantissa = (linearValue >> (exponent + 3)) & 0x0F;
  const ulawByte = ~(sign | (exponent << 4) | mantissa) & 0xFF;
  
  return ulawByte;
}

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
      Phone: reservationData.contact_info.phone || '',
      Status: 'Confirmed'
    });
    
    console.log('Réservation ajoutée au Google Sheet');
    return { 
      success: true, 
      message: 'Reservation confirmed successfully',
      details: {
        date: reservationData.reservation_date,
        guests: reservationData.guests_count,
        name: reservationData.contact_info.name
      }
    };
  } catch (error) {
    console.error('Erreur Google Sheets:', error);
    return { success: false, error: error.message };
  }
}

// Fonction pour rechercher une réservation
async function findReservation(searchCriteria) {
  try {
    const doc = new GoogleSpreadsheet(GOOGLE_SHEET_ID, serviceAccountAuth);
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    const rows = await sheet.getRows();
    
    let foundReservations = [];
    
    // Recherche par numéro de téléphone d'abord
    if (searchCriteria.phone) {
      foundReservations = rows.filter(row => 
        row.get('Phone') === searchCriteria.phone && 
        row.get('Status') !== 'Cancelled'
      );
    }
    
    // Si aucune réservation trouvée avec le téléphone, chercher par nom
    if (foundReservations.length === 0 && searchCriteria.name) {
      foundReservations = rows.filter(row => 
        row.get('Name')?.toLowerCase() === searchCriteria.name.toLowerCase() && 
        row.get('Status') !== 'Cancelled'
      );
    }
    
    if (foundReservations.length === 0) {
      return { 
        success: false, 
        message: 'No reservation found',
        found: 0 
      };
    }
    
    // Retourner les détails des réservations trouvées
    const reservations = foundReservations.map(row => ({
      rowNumber: row.rowNumber,
      date: row.get('Date'),
      guests: row.get('Guests'),
      name: row.get('Name'),
      phone: row.get('Phone'),
      status: row.get('Status')
    }));
    
    return { 
      success: true, 
      reservations: reservations,
      found: reservations.length
    };
  } catch (error) {
    console.error('Erreur recherche réservation:', error);
    return { success: false, error: error.message };
  }
}

// Fonction pour modifier une réservation
async function modifyReservation(modificationData) {
  try {
    const doc = new GoogleSpreadsheet(GOOGLE_SHEET_ID, serviceAccountAuth);
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    const rows = await sheet.getRows();
    
    // Trouver la ligne à modifier
    const rowToUpdate = rows.find(row => row.rowNumber === modificationData.rowNumber);
    
    if (!rowToUpdate) {
      return { success: false, error: 'Reservation not found' };
    }
    
    // Appliquer les modifications
    if (modificationData.new_date) {
      rowToUpdate.set('Date', modificationData.new_date);
    }
    if (modificationData.new_guests_count) {
      rowToUpdate.set('Guests', modificationData.new_guests_count);
    }
    if (modificationData.new_time) {
      // Si le temps est séparé de la date
      const currentDate = rowToUpdate.get('Date').split('T')[0];
      rowToUpdate.set('Date', `${currentDate}T${modificationData.new_time}`);
    }
    
    await rowToUpdate.save();
    
    console.log('Réservation modifiée');
    return { 
      success: true, 
      message: 'Reservation modified successfully',
      updatedReservation: {
        date: rowToUpdate.get('Date'),
        guests: rowToUpdate.get('Guests'),
        name: rowToUpdate.get('Name')
      }
    };
  } catch (error) {
    console.error('Erreur modification réservation:', error);
    return { success: false, error: error.message };
  }
}

// Fonction pour annuler une réservation
async function cancelReservation(cancellationData) {
  try {
    const doc = new GoogleSpreadsheet(GOOGLE_SHEET_ID, serviceAccountAuth);
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    const rows = await sheet.getRows();
    
    // Trouver la ligne à annuler
    const rowToCancel = rows.find(row => row.rowNumber === cancellationData.rowNumber);
    
    if (!rowToCancel) {
      return { success: false, error: 'Reservation not found' };
    }
    
    // Marquer comme annulée plutôt que de supprimer
    rowToCancel.set('Status', 'Cancelled');
    await rowToCancel.save();
    
    console.log('Réservation annulée');
    return { 
      success: true, 
      message: 'Reservation cancelled successfully',
      cancelledReservation: {
        date: rowToCancel.get('Date'),
        name: rowToCancel.get('Name')
      }
    };
  } catch (error) {
    console.error('Erreur annulation réservation:', error);
    return { success: false, error: error.message };
  }
}

// Fonction pour terminer l'appel avec délai
async function endCall(ws, delay = 3000) {
  try {
    console.log('Fin de l\'appel demandée par l\'assistant');
    
    // Attendre un délai avant de raccrocher pour permettre la fin du message
    setTimeout(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          event: 'hangup',
          streamSid: ws.streamSid
        }));
      }
    }, delay);
    
    return { success: true, message: 'Call will end shortly' };
  } catch (error) {
    console.error('Erreur lors du raccrochage:', error);
    return { success: false, error: error.message };
  }
}

app.get('/', (req, res) => {
  res.send('Server running');
});

app.post('/voice', (req, res) => {
  console.log('Appel reçu de:', req.body.From);
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

wss.on('connection', (ws, req) => {
  console.log('WebSocket Twilio connecté');
  
  // Extraire le numéro de téléphone de la requête
  const urlParams = new URLSearchParams(req.url.split('?')[1]);
  const callerPhone = urlParams.get('from') || '';
  console.log('Numéro appelant:', callerPhone);
  
  let elevenLabsWs = null;
  let isPlaying = false;
  
  // Variables pour la gestion de conversation
  let lastUserSpeechTime = Date.now();
  let isUserSpeaking = false;
  let conversationStarted = false;
  let hasGreeted = false; // Éviter les salutations multiples
  let pendingReservation = null; // Stocker la réservation en cours
  
  // Variables pour le son d'ambiance - optimisées
  let backgroundSoundBuffer = null;
  let backgroundSoundPosition = 0;
  let isSendingBackground = false;
  let backgroundInterval = null;
  
  // Charger le fichier audio d'ambiance
  function loadBackgroundSound() {
    try {
      if (fs.existsSync(BACKGROUND_SOUND_PATH)) {
        backgroundSoundBuffer = fs.readFileSync(BACKGROUND_SOUND_PATH);
        console.log('Son d\'ambiance chargé:', backgroundSoundBuffer.length, 'bytes');
        return true;
      } else {
        console.log('Fichier son d\'ambiance non trouvé:', BACKGROUND_SOUND_PATH);
        return false;
      }
    } catch (error) {
      console.error('Erreur chargement son ambiance:', error);
      return false;
    }
  }
  
  // Fonction pour créer une connexion ElevenLabs WebSocket optimisée
  function connectElevenLabs() {
    elevenLabsWs = new WebSocket('wss://api.elevenlabs.io/v1/text-to-speech/' + ELEVENLABS_VOICE_ID + '/stream-input?model_id=eleven_flash_v2_5&output_format=ulaw_8000', {
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY
      }
    });
    
    elevenLabsWs.on('open', () => {
      console.log('ElevenLabs WebSocket connecté');
      
      // Configuration optimisée pour la latence
      elevenLabsWs.send(JSON.stringify({
        text: " ",
        voice_settings: {
          stability: 0.1,
          similarity_boost: 1.0,
          style: 1.0,
          use_speaker_boost: true
        },
        generation_config: {
          chunk_length_schedule: [30, 80, 120] // Chunks plus petits pour interruption plus rapide
        }
      }));
    });
    
    elevenLabsWs.on('message', (data) => {
      const response = JSON.parse(data);
      
      if (response.audio) {
        // Arrêter temporairement le son d'ambiance pendant que la voix parle
        isSendingBackground = false;
        
        // Envoyer directement à Twilio (déjà en ulaw)
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            event: 'media',
            streamSid: ws.streamSid,
            media: {
              payload: response.audio
            }
          }));
        }
        
        // Reprendre le son d'ambiance après un délai plus court
        setTimeout(() => {
          isSendingBackground = true;
        }, 50);
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
    
    // Démarrer le son d'ambiance (volume réduit)
    if (loadBackgroundSound()) {
      console.log('Son d\'ambiance activé');
      isSendingBackground = true;
      
      // Envoyer le son d'ambiance moins fréquemment pour réduire la charge
      backgroundInterval = setInterval(() => {
        if (isSendingBackground && ws.readyState === WebSocket.OPEN && backgroundSoundBuffer) {
          const chunkSize = 160;
          const chunk = Buffer.alloc(chunkSize);
          
          for (let i = 0; i < chunkSize; i++) {
            chunk[i] = backgroundSoundBuffer[(backgroundSoundPosition + i) % backgroundSoundBuffer.length];
          }
          
          backgroundSoundPosition = (backgroundSoundPosition + chunkSize) % backgroundSoundBuffer.length;
          
          // Ajuster le volume (plus faible)
          const adjustedChunk = Buffer.alloc(chunkSize);
          for (let i = 0; i < chunkSize; i++) {
            const sample = ulaw2linear(chunk[i]);
            const adjusted = Math.round(sample * BACKGROUND_VOLUME);
            adjustedChunk[i] = linear2ulaw(adjusted);
          }
          
          ws.send(JSON.stringify({
            event: 'media',
            streamSid: ws.streamSid,
            media: {
              payload: adjustedChunk.toString('base64')
            }
          }));
        }
      }, 25); // Moins fréquent
    }
    
    // Configuration de session optimisée
    openaiWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        modalities: ['text'],
        instructions: `You are Maria, the friendly front desk assistant at Casa Masa restaurant. 

IMPORTANT CONVERSATION FLOW:
1. After greeting, WAIT for the customer to speak before saying anything else
2. When taking a reservation, after confirming details, ALWAYS ask: "Is there anything else I can help you with today?"
3. Only end the call when the customer says goodbye or indicates they're done
4. Keep responses concise and natural - avoid being too chatty
5. Don't repeat information unnecessarily

PERSONALITY:
- Warm, professional, and conversational
- Use natural speech patterns with occasional "um", "let's see", etc.
- Be patient and helpful
- Speak at a comfortable pace

RESERVATION PROCESS:
- Get date, time, number of guests, and name
- Confirm all details before booking
- After successful booking, ask if they need anything else
- Be helpful with modifications or questions

Remember: Wait for customer responses and don't rush the conversation.`,
        input_audio_format: 'g711_ulaw',
        input_audio_transcription: {
          model: 'whisper-1'
        },
        input_audio_noise_reduction: {
          type: 'near_field'
        },
        speed: 1.5,
        temperature: 1.2,
        turn_detection: {
          type: 'server_vad',
          threshold: 0.3, // Plus sensible pour détecter rapidement
          prefix_padding_ms: 100, // Réduit pour réaction plus rapide
          silence_duration_ms: 100, // Réduit pour interruption plus rapide
          create_response: true
        },
        tools: [
          {
            type: 'function',
            name: 'make_reservation',
            description: 'Create a new restaurant reservation',
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
                    }
                  }
                }
              },
              required: ['reservation_date', 'guests_count', 'contact_info']
            }
          },
          {
            type: 'function',
            name: 'find_reservation',
            description: 'Search for existing reservations by phone number or name',
            parameters: {
              type: 'object',
              properties: {
                phone: {
                  type: 'string',
                  description: 'Phone number to search'
                },
                name: {
                  type: 'string',
                  description: 'Customer name to search'
                }
              },
              required: []
            }
          },
          {
            type: 'function',
            name: 'modify_reservation',
            description: 'Modify an existing reservation',
            parameters: {
              type: 'object',
              properties: {
                rowNumber: {
                  type: 'number',
                  description: 'Row number of the reservation to modify'
                },
                new_date: {
                  type: 'string',
                  description: 'New date and time in ISO format (optional)'
                },
                new_guests_count: {
                  type: 'number',
                  description: 'New number of guests (optional)'
                },
                new_time: {
                  type: 'string',
                  description: 'New time only in HH:MM:SS format (optional)'
                }
              },
              required: ['rowNumber']
            }
          },
          {
            type: 'function',
            name: 'cancel_reservation',
            description: 'Cancel an existing reservation',
            parameters: {
              type: 'object',
              properties: {
                rowNumber: {
                  type: 'number',
                  description: 'Row number of the reservation to cancel'
                }
              },
              required: ['rowNumber']
            }
          },
          {
            type: 'function',
            name: 'end_call',
            description: 'End the phone call politely after customer is done',
            parameters: {
              type: 'object',
              properties: {},
              required: []
            }
          }
        ]
      }
    }));
    
    // Message d'accueil - seulement une fois
    setTimeout(() => {
      if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN && !hasGreeted) {
        hasGreeted = true;
        elevenLabsWs.send(JSON.stringify({
          text: "Hello, Casa Masa restaurant, how can I help you today?",
          flush: true
        }));
      }
    }, 800); // Délai plus court
  });

  let textBuffer = '';
  let isAssistantSpeaking = false;
  
  openaiWs.on('message', async (data) => {
    try {
      const response = JSON.parse(data);
      
      // Détecter quand l'utilisateur commence à parler
      if (response.type === 'input_audio_buffer.speech_started') {
        console.log('Utilisateur commence à parler - INTERRUPTION');
        isUserSpeaking = true;
        conversationStarted = true;
        
        // INTERRUPTION IMMÉDIATE - Annuler toute génération en cours
        if (isAssistantSpeaking) {
          console.log('Interruption de l\'assistant');
          
          // 1. Vider le buffer texte
          textBuffer = '';
          isAssistantSpeaking = false;
          
          // 2. Stopper ElevenLabs immédiatement
          if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
            elevenLabsWs.send(JSON.stringify({
              text: "",
              flush: true
            }));
          }
          
          // 3. Annuler la réponse OpenAI en cours
          if (openaiWs.readyState === WebSocket.OPEN) {
            openaiWs.send(JSON.stringify({
              type: 'response.cancel'
            }));
          }
        }
      }
      
      // Détecter quand l'utilisateur arrête de parler
      if (response.type === 'input_audio_buffer.speech_stopped') {
        console.log('Utilisateur arrête de parler');
        isUserSpeaking = false;
        lastUserSpeechTime = Date.now();
      }
      
      // Détecter la transcription en temps réel
      if (response.type === 'conversation.item.input_audio_transcription.completed') {
        const transcript = response.transcript;
        console.log('Transcription:', transcript);
      }
      
      // Capturer le texte en streaming - optimisé
      if (response.type === 'response.text.delta' && response.delta) {
        textBuffer += response.delta;
        isAssistantSpeaking = true;
        
        // Envoyer à ElevenLabs par chunks plus petits pour la réactivité
        const chunks = textBuffer.match(/.{1,30}[.!?,\s]|.{1,40}$/g) || [];
        
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
        isAssistantSpeaking = false;
      }
      
      // Gestion des appels de fonction
      if (response.type === 'response.function_call_arguments.done') {
        console.log('Function call:', response.name, response.arguments);
        
        let result;
        const args = JSON.parse(response.arguments);
        
        switch(response.name) {
          case 'make_reservation':
            result = await addReservation(args);
            pendingReservation = result; // Stocker pour suivi
            break;
            
          case 'find_reservation':
            // Si pas de téléphone fourni, utiliser celui de l'appelant
            if (!args.phone && callerPhone) {
              args.phone = callerPhone;
            }
            result = await findReservation(args);
            break;
            
          case 'modify_reservation':
            result = await modifyReservation(args);
            break;
            
          case 'cancel_reservation':
            result = await cancelReservation(args);
            break;
            
          case 'end_call':
            result = await endCall(ws, 2000); // Délai plus court
            
            // Fermer les connexions après le raccrochage
            setTimeout(() => {
              if (openaiWs.readyState === WebSocket.OPEN) {
                openaiWs.close();
              }
              if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
                elevenLabsWs.close();
              }
              if (ws.readyState === WebSocket.OPEN) {
                ws.close();
              }
            }, 2500);
            break;
        }
        
        if (result) {
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
        if (backgroundInterval) {
          clearInterval(backgroundInterval);
          backgroundInterval = null;
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
    if (backgroundInterval) {
      clearInterval(backgroundInterval);
      backgroundInterval = null;
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