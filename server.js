const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const platformConfig = require('./public/platforms.js');
const path = require('path');

// Load environment variables
require('dotenv').config();

// Import Firebase authentication
const { serverAuthManager, socketAuthMiddleware } = require('./firebase-admin.js');

// Environment validation for critical variables
const requiredEnvVars = ['JWT_SECRET'];
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingVars.length > 0) {
    console.error('Missing required environment variables:', missingVars);
    console.error('Please copy environment.template to .env and configure the required values');
    process.exit(1);
}

// Environment-based logging
const isDevelopment = process.env.NODE_ENV !== 'production';
const log = {
    info: (...args) => isDevelopment && console.log('[INFO]', ...args),
    warn: (...args) => isDevelopment && console.warn('[WARN]', ...args),
    error: (...args) => console.error('[ERROR]', ...args), // Always log errors
    debug: (...args) => process.env.DEBUG === 'true' && console.log('[DEBUG]', ...args)
};

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Security middleware
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: [
                "'self'", 
                "'unsafe-inline'", 
                "https://www.gstatic.com", 
                "https://www.googleapis.com",
                "https://cdn.socket.io",           // Socket.IO CDN
                "https://cdn.jsdelivr.net"        // Phaser.js CDN
            ],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc: [
                "'self'", 
                "https://fonts.gstatic.com",
                "data:"                           // Allow data URI fonts (Phaser uses these)
            ],
            imgSrc: ["'self'", "data:", "https:", "blob:"],
            connectSrc: [
                "'self'", 
                "ws:", 
                "wss:", 
                "https://identitytoolkit.googleapis.com", 
                "https://securetoken.googleapis.com",
                "https://firestore.googleapis.com",        // Firestore database connections
                "https://firebaseinstallations.googleapis.com" // Firebase installations
            ]
        }
    }
}));

// CORS configuration
const allowedOrigins = process.env.NODE_ENV === 'production' 
    ? (process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',') : ['https://yourdomain.com'])
    : ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:8080', 'http://127.0.0.1:8080'];

app.use(cors({
    origin: allowedOrigins,
    credentials: true
}));

// Rate limiting - permissive for multiplayer gaming
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: process.env.NODE_ENV === 'production' ? 1000 : 1000, // High limit for multiplayer gaming
    message: 'Too many requests from this IP, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => {
        // Skip rate limiting for localhost in development
        if (process.env.NODE_ENV !== 'production') {
            const isLocalhost = req.ip === '127.0.0.1' || 
                              req.ip === '::1' || 
                              req.ip === '::ffff:127.0.0.1' ||
                              req.connection.remoteAddress === '127.0.0.1';
            return isLocalhost;
        }
        return false;
    }
});
app.use(limiter);

// Body parsing with size limits
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Firebase configuration endpoint - serves config from environment variables
app.get('/firebase-config', (req, res) => {
    // Only require the essential variables we actually need
    const requiredFirebaseVars = [
        'FIREBASE_PROJECT_ID'  // Only this is truly required, others have fallbacks
    ];
    
    const missingFirebaseVars = requiredFirebaseVars.filter(varName => !process.env[varName]);
    
    // Debug logging for development
    log.info('Firebase config request received');
    log.info('Environment variables check:', {
        NODE_ENV: process.env.NODE_ENV,
        hasFirebaseProjectId: !!process.env.FIREBASE_PROJECT_ID,
        hasFirebaseApiKey: !!process.env.FIREBASE_API_KEY,
        usingFallbackApiKey: !process.env.FIREBASE_API_KEY
    });
    
    if (missingFirebaseVars.length > 0) {
        log.error('Missing Firebase environment variables:', missingFirebaseVars);
        return res.status(500).json({ 
            error: 'Firebase configuration incomplete',
            missing: missingFirebaseVars 
        });
    }
    
    // Return Firebase config using actual working values with fallbacks for local dev
    const firebaseConfig = {
        apiKey: process.env.FIREBASE_API_KEY || "AIzaSyAh2m1SciisBB6EDxmShQJyxW1uAp0Z32I",
        authDomain: `${process.env.FIREBASE_PROJECT_ID}.firebaseapp.com`,
        projectId: process.env.FIREBASE_PROJECT_ID,
        storageBucket: `${process.env.FIREBASE_PROJECT_ID}.firebasestorage.app`,
        messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || "799099672774",
        appId: process.env.FIREBASE_APP_ID || "1:799099672774:web:8e080095ca01c28a1cdfc7"
    };
    
    log.info('Returning Firebase config successfully');
    res.json(firebaseConfig);
});

app.use(express.static('public')); // Serve index.html from 'public' directory

const players = {};

// Game constants
const ATTACK_RANGE = 70;
const ATTACK_DAMAGE = 15;
const MOVEMENT_SPEED = 4; // Increased by 1.5x for more responsive movement
const GRAVITY = 1200; // Increased for snappier falls
const GROUND_Y = 524; // Ground level for platform at Y=580, height=32, player height=80: 580-16-40=524
const FRAME_RATE = 30; // Match actual tick rate for consistency

// Mobile controller combat constants
const LIGHT_DAMAGE = 10;
const LIGHT_RANGE = 70;
const LIGHT_COOLDOWN = 300;
const HEAVY_DAMAGE = 22;
const HEAVY_RANGE = 85;
const HEAVY_COOLDOWN = 800;
const HEAVY_KNOCKBACK_MULT = 1.5;
const HEAVY_STARTUP = 120; // ms

// Death boundary constants - extended fall-off area
const DEATH_BOUNDARIES = {
    LEFT: -200,      // Extended 200px to the left of play area
    RIGHT: 1000,     // Extended 200px to the right of play area (800 + 200)
    BOTTOM: 950      // Extended ~400px below ground (3 jump heights) for recovery attempts
};

// Lives system constants
const STARTING_LIVES = 3;
const INVINCIBILITY_DURATION = 2000; // 2 seconds in milliseconds
const RESPAWN_DELAY = 3000; // 3 seconds before respawn (with countdown)

// Dash system constants
const DASH_VELOCITY = 900; // Horizontal velocity boost (increased from 300)
const DASH_DURATION = 150; // Duration in milliseconds (reduced from 200 for snappier feel)
const DASH_COOLDOWN = 1000; // Cooldown between dashes in milliseconds (1 second for mobile controller)
const DASH_DECAY_RATE = 0.85; // Velocity decay factor per frame (faster decay to prevent overshoot)

// Platform system
const { PLATFORMS, PLATFORM_TYPES, GAME_BOUNDS, PLATFORM_PHYSICS, PlatformUtils } = platformConfig;

// ==================== PLAYER NAME UTILITIES ====================

// Helper function to get player display name from socket
function getPlayerDisplayName(socket) {
    console.log(`[DEBUG] getPlayerDisplayName called for socket ${socket.id}`);
    console.log(`[DEBUG] socket.user:`, socket.user ? {
        uid: socket.user.uid,
        displayName: socket.user.displayName,
        isGuest: socket.user.isGuest,
        isAnonymous: socket.user.isAnonymous
    } : 'null');
    
    if (socket.user && socket.user.displayName) {
        console.log(`[DEBUG] Using authenticated displayName: ${socket.user.displayName}`);
        return socket.user.displayName;
    }
    
    // Fallback to truncated socket ID if no authenticated user
    const fallbackName = `Player ${socket.id.substring(0, 8)}...`;
    console.log(`[DEBUG] Using fallback name: ${fallbackName}`);
    return fallbackName;
}

// Helper function to update player stats in Firestore after match
async function updatePlayerStatsInFirestore(playerId, playerSocket, stats) {
    try {
        if (!playerSocket || !playerSocket.user || !playerSocket.user.uid) {
            // Skip Firestore update for unauthenticated users
            console.log(`[STATS] Skipping Firestore update for unauthenticated user: ${playerId}`);
            return;
        }
        
        console.log(`[STATS] Updating stats for user ${playerSocket.user.uid} (${playerSocket.user.displayName}) - isGuest: ${playerSocket.user.isGuest}`);

        const uid = playerSocket.user.uid;
        const { serverAuthManager } = require('./firebase-admin.js');
        
        // Get user's current stats from Firestore
        const userResult = await serverAuthManager.getUserData(uid);
        if (!userResult.success) {
            console.error(`Failed to get user data for stats update: ${uid}`);
            return;
        }

        const currentStats = userResult.userData;
        
        // Calculate new cumulative stats
        const newStats = {
            gamesPlayed: (currentStats.gamesPlayed || 0) + 1,
            wins: (currentStats.wins || 0) + (stats.isWinner ? 1 : 0),
            losses: (currentStats.losses || 0) + (stats.isWinner ? 0 : 1),
            totalKills: (currentStats.totalKills || 0) + (stats.kills || 0),
            totalDeaths: (currentStats.totalDeaths || 0) + (stats.deaths || 0),
            lastActive: new Date().toISOString()
        };

        // Update user stats in Firestore
        const updateResult = await serverAuthManager.updateUserStats(uid, newStats);
        if (updateResult.success) {
            console.log(`Updated stats for user ${uid}: +${stats.kills} kills, +${stats.deaths} deaths, winner: ${stats.isWinner}`);
        } else {
            console.error(`Failed to update stats for user ${uid}:`, updateResult.error);
        }
        
    } catch (error) {
        console.error(`Error updating stats for player ${playerId}:`, error);
    }
}

// ==================== SESSION CODE SYSTEM ====================

// Room system constants
const ROOM_CONFIG = {
    CODE_LENGTH: 4,
    MAX_PLAYERS: 8,
    CLEANUP_INTERVAL: 30000, // 30 seconds
    EMPTY_ROOM_TIMEOUT: 300000, // 5 minutes in milliseconds
    INACTIVE_ROOM_TIMEOUT: 3600000, // 1 hour in milliseconds
    ALLOWED_CHARACTERS: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
};

// Room storage - In production, this would be Redis
const rooms = new Map();

// Room code generation and validation functions
function generateRoomCode() {
    const chars = ROOM_CONFIG.ALLOWED_CHARACTERS;
    let code;
    let attempts = 0;
    const maxAttempts = 1000;
    
    do {
        code = '';
        for (let i = 0; i < ROOM_CONFIG.CODE_LENGTH; i++) {
            code += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        attempts++;
        
        if (attempts > maxAttempts) {
            throw new Error('Unable to generate unique room code after maximum attempts');
        }
    } while (rooms.has(code));
    
    return code;
}

function validateRoomCode(code) {
    if (!code || typeof code !== 'string') {
        return { valid: false, error: 'Room code must be a string' };
    }
    
    const normalizedCode = code.toUpperCase().trim();
    
    if (normalizedCode.length !== ROOM_CONFIG.CODE_LENGTH) {
        return { valid: false, error: `Room code must be exactly ${ROOM_CONFIG.CODE_LENGTH} characters` };
    }
    
    if (!/^[A-Z]+$/.test(normalizedCode)) {
        return { valid: false, error: 'Room code must contain only letters' };
    }
    
    return { valid: true, code: normalizedCode };
}

function createRoom(hostSocketId) {
    const code = generateRoomCode();
    const room = {
        code: code,
        hostId: hostSocketId,
        players: new Map(), // socketId -> playerData
        createdAt: Date.now(),
        lastActivity: Date.now(),
        isActive: true,
        gameState: {
            phase: 'lobby', // lobby, countdown, in-progress, game-over
            gameStarted: false,
            matchInProgress: false
        },
        disconnectionTimer: null, // Timer for 10-second grace period
        disconnectedPlayers: new Map() // socketId -> disconnection time
    };
    
    rooms.set(code, room);
    console.log(`Room created: ${code} by host ${hostSocketId}`);
    
    return room;
}

function joinRoom(code, socketId, playerData = null) {
    const validation = validateRoomCode(code);
    if (!validation.valid) {
        return { success: false, error: validation.error };
    }
    
    const normalizedCode = validation.code;
    const room = rooms.get(normalizedCode);
    
    if (!room) {
        return { success: false, error: 'Room not found' };
    }
    
    if (!room.isActive) {
        return { success: false, error: 'Room is no longer active' };
    }
    
    if (room.players.size >= ROOM_CONFIG.MAX_PLAYERS) {
        return { success: false, error: 'Room is full' };
    }
    
    if (room.players.has(socketId)) {
        return { success: false, error: 'Already in this room' };
    }
    
    // Check if this is a rejoining player during grace period
    const isRejoiningDuringGrace = room.disconnectedPlayers.has(socketId);
    
    // Check if game is in progress - don't allow new players to join mid-game (but allow rejoins during grace period)
    if ((room.gameState.phase === 'in-progress' || room.gameState.phase === 'countdown') && !isRejoiningDuringGrace) {
        return { success: false, error: 'Game already in progress. Please wait for the next round.' };
    }
    
    if (isRejoiningDuringGrace) {
        // Player is rejoining during grace period
        console.log(`Player ${socketId} rejoined room ${normalizedCode} during grace period - cancelling timer`);
        
        // Cancel the disconnection timer
        if (room.disconnectionTimer) {
            clearTimeout(room.disconnectionTimer);
            room.disconnectionTimer = null;
        }
        
        // Restore player data
        const disconnectedData = room.disconnectedPlayers.get(socketId);
        room.disconnectedPlayers.delete(socketId);
        
        // Add player back to room with their original data
        room.players.set(socketId, disconnectedData.playerData || {});
        
        // Restore player in global players object if they were removed
        if (!players[socketId] && disconnectedData.playerData) {
            players[socketId] = disconnectedData.playerData;
        }
        
        // Notify other players that player rejoined
        return { success: true, room: room, rejoined: true };
    }
    
    // Add player to room
    room.players.set(socketId, playerData || {});
    room.lastActivity = Date.now();
    
    console.log(`Player ${socketId} joined room ${normalizedCode} (${room.players.size}/${ROOM_CONFIG.MAX_PLAYERS})`);
    
    return { success: true, room: room };
}

function leaveRoom(socketId) {
    let leftRoom = null;
    
    for (const [code, room] of rooms.entries()) {
        if (room.players.has(socketId)) {
            room.players.delete(socketId);
            room.lastActivity = Date.now();
            leftRoom = room;
            
            console.log(`Player ${socketId} left room ${code} (${room.players.size}/${ROOM_CONFIG.MAX_PLAYERS})`);
            
            // If room is empty, mark for cleanup
            if (room.players.size === 0) {
                room.emptyAt = Date.now();
            }
            
            // If host left, handle based on game state
            if (room.hostId === socketId) {
                if (room.players.size > 0) {
                    // If game hasn't started yet, close the room
                    if (room.gameState.phase === 'lobby') {
                        console.log(`Host left room ${code} before game started - closing room`);
                        // Notify all remaining players that room is closing
                        room.players.forEach((_, playerId) => {
                            const playerSocket = io.sockets.sockets.get(playerId);
                            if (playerSocket) {
                                playerSocket.emit('roomClosed', {
                                    reason: 'Host left the room',
                                    message: 'The host has left the room. Returning to main menu.'
                                });
                                playerSocket.leave(code);
                            }
                        });
                        // Clear all players and mark for immediate cleanup
                        room.players.clear();
                        room.emptyAt = Date.now();
                        room.isActive = false;
                    } else {
                        // Game is in progress or finished, assign new host
                        const newHostId = room.players.keys().next().value;
                        room.hostId = newHostId;
                        console.log(`New host for room ${code}: ${newHostId}`);
                    }
                } else {
                    // Host left empty room - close it immediately
                    console.log(`Host left empty room ${code} - closing room immediately`);
                    room.emptyAt = Date.now();
                    room.isActive = false;
                }
            }
            
            break;
        }
    }
    
    return leftRoom;
}

function getRoomByPlayer(socketId) {
    for (const [code, room] of rooms.entries()) {
        if (room.players.has(socketId)) {
            return { code, room };
        }
    }
    return null;
}

function updateRoomActivity(code) {
    const room = rooms.get(code);
    if (room) {
        room.lastActivity = Date.now();
        if (room.emptyAt) {
            delete room.emptyAt;
        }
    }
}

// Room cleanup system
function cleanupRooms() {
    const now = Date.now();
    const roomsToDelete = [];
    
    for (const [code, room] of rooms.entries()) {
        let shouldDelete = false;
        
        // Remove empty rooms after timeout
        if (room.players.size === 0 && room.emptyAt && 
            (now - room.emptyAt) > ROOM_CONFIG.EMPTY_ROOM_TIMEOUT) {
            shouldDelete = true;
            console.log(`Cleaning up empty room: ${code}`);
        }
        
        // Remove inactive rooms after timeout
        if ((now - room.lastActivity) > ROOM_CONFIG.INACTIVE_ROOM_TIMEOUT) {
            shouldDelete = true;
            console.log(`Cleaning up inactive room: ${code} (inactive for ${Math.round((now - room.lastActivity) / 60000)} minutes)`);
        }
        
        if (shouldDelete) {
            roomsToDelete.push(code);
        }
    }
    
    // Delete marked rooms
    roomsToDelete.forEach(code => {
        const room = rooms.get(code);
        if (room) {
            // Clear any active disconnection timer
            if (room.disconnectionTimer) {
                clearTimeout(room.disconnectionTimer);
                room.disconnectionTimer = null;
            }
            
            // Notify any remaining players
            room.players.forEach((_, socketId) => {
                const socket = io.sockets.sockets.get(socketId);
                if (socket) {
                    socket.emit('roomClosed', { reason: 'cleanup', code });
                    socket.leave(code);
                }
            });
        }
        rooms.delete(code);
    });
    
    if (roomsToDelete.length > 0) {
        console.log(`Cleaned up ${roomsToDelete.length} room(s). Active rooms: ${rooms.size}`);
    }
}

// Start cleanup interval
setInterval(cleanupRooms, ROOM_CONFIG.CLEANUP_INTERVAL);

// ==================== END SESSION CODE SYSTEM ====================

// Helper function for room-scoped broadcasts
function emitToPlayerRoom(socketId, event, data) {
    const roomInfo = getRoomByPlayer(socketId);
    if (roomInfo) {
        io.to(roomInfo.code).emit(event, data);
        updateRoomActivity(roomInfo.code);
    } else {
        // Fallback for players not in rooms (shouldn't happen in normal flow)
        console.warn(`Player ${socketId} not in any room, skipping ${event} broadcast`);
    }
}

// Helper function to broadcast to all rooms
function emitToAllRooms(event, data) {
    for (const [roomCode, room] of rooms.entries()) {
        if (room.isActive && room.players.size > 0) {
            io.to(roomCode).emit(event, data);
            updateRoomActivity(roomCode);
        }
    }
}

// Helper function to get all players in the same room as a given player
function getPlayersInSameRoom(socketId) {
    const roomInfo = getRoomByPlayer(socketId);
    if (roomInfo) {
        const roomPlayers = {};
        for (const playerSocketId of roomInfo.room.players.keys()) {
            if (players[playerSocketId]) {
                roomPlayers[playerSocketId] = players[playerSocketId];
            }
        }
        return roomPlayers;
    }
    return {};
}

// Helper function to calculate distance between two points
function getDistance(player1, player2) {
    const dx = player1.x - player2.x;
    const dy = player1.y - player2.y;
    return Math.sqrt(dx * dx + dy * dy);
}

// Death boundary detection and life management
function checkPlayerDeath(player, playerId) {
    // Skip death check if player is already dead, eliminated, or invincible
    if (player.isDead || player.eliminated || player.isInvincible) {
        return false;
    }
    
    // Check if player has fallen beyond death boundaries
    const isOutOfBounds = player.x < DEATH_BOUNDARIES.LEFT || 
                         player.x > DEATH_BOUNDARIES.RIGHT || 
                         player.y > DEATH_BOUNDARIES.BOTTOM;
    
    // Debug logging for fall-through testing
    if (player.y > 600) { // Log when players enter the pit area
        console.log(`Player ${playerId} in pit: x=${player.x}, y=${player.y}, outOfBounds=${isOutOfBounds}`);
    }
    if (player.x < -150 || player.x > 950 || player.y > 850) {
        console.log(`Player ${playerId} near death boundary: x=${player.x}, y=${player.y}, outOfBounds=${isOutOfBounds}`);
    }
    
    if (isOutOfBounds) {
        // Player has died - deduct a life and increment death counter
        player.lives--;
        player.deaths++;
        player.isDead = true;
        player.deathTime = Date.now();
        
        // Check if death should be attributed to another player (kill attribution)
        const KILL_ATTRIBUTION_WINDOW = 5000; // 5 seconds
        let killerMessage = '';
        if (player.lastAttacker && 
            player.lastAttackTime && 
            (Date.now() - player.lastAttackTime) < KILL_ATTRIBUTION_WINDOW &&
            players[player.lastAttacker] && 
            !players[player.lastAttacker].eliminated) {
            
            // Give kill credit to the attacker
            players[player.lastAttacker].kills++;
            killerMessage = ` (killed by ${player.lastAttacker})`;
            console.log(`${player.lastAttacker} gets a kill! Total kills: ${players[player.lastAttacker].kills}`);
        }
        
        console.log(`Player ${playerId} died! Lives remaining: ${player.lives}, Total deaths: ${player.deaths}${killerMessage}`);
        
        // Check if player is eliminated (no lives left)
        if (player.lives <= 0) {
            player.eliminated = true;
            console.log(`Player ${playerId} eliminated!`);
            
                    // Emit elimination event to room
        emitToPlayerRoom(playerId, 'playerEliminated', {
            playerId: playerId,
            finalPosition: { x: player.x, y: player.y },
            timestamp: Date.now()
        });
            
            // Check for match end in the player's room
            const roomInfo = getRoomByPlayer(playerId);
            if (roomInfo) {
                checkMatchEnd(roomInfo.code);
            }
        } else {
            // Schedule respawn
            setTimeout(() => {
                if (players[playerId] && !players[playerId].eliminated) {
                    respawnPlayer(players[playerId], playerId);
                }
            }, RESPAWN_DELAY);
        }
        
        // Emit death event to room
        emitToPlayerRoom(playerId, 'playerDeath', {
            playerId: playerId,
            livesRemaining: player.lives,
            deathPosition: { x: player.x, y: player.y },
            isEliminated: player.eliminated,
            timestamp: Date.now()
        });
        
        return true;
    }
    
    return false;
}

// Respawn system
function respawnPlayer(player, playerId) {
    if (player.eliminated) return;
    
    // Get a random spawn point
    const spawnPlatforms = PLATFORMS.filter(p => p.type === PLATFORM_TYPES.SPAWN);
    const randomSpawnPlatform = spawnPlatforms[Math.floor(Math.random() * spawnPlatforms.length)];
    const spawnX = randomSpawnPlatform.x;
    const spawnY = PlatformUtils.getPlayerStandingY(randomSpawnPlatform);
    
    // Reset player state
    player.x = spawnX;
    player.y = spawnY;
    player.velocityX = 0;
    player.velocityY = 0;
    player.isDead = false;
    player.isGrounded = true;
    player.jumpsRemaining = 2;
    player.health = player.maxHealth; // Full health on respawn
    
    // Grant invincibility period
    player.isInvincible = true;
    player.invincibilityEndTime = Date.now() + INVINCIBILITY_DURATION;
    
    console.log(`Player ${playerId} respawned at (${spawnX}, ${spawnY}) with invincibility`);
    
    // Emit respawn event to room
    emitToPlayerRoom(playerId, 'playerRespawn', {
        playerId: playerId,
        position: { x: spawnX, y: spawnY },
        livesRemaining: player.lives,
        invincibilityDuration: INVINCIBILITY_DURATION,
        timestamp: Date.now()
    });
}

// Check if match should end (only one player remaining) - room-specific
function checkMatchEnd(roomCode = null) {
    // If no room specified, check all active rooms
    const roomsToCheck = roomCode ? [roomCode] : Array.from(rooms.keys()).filter(code => 
        rooms.get(code).isActive && rooms.get(code).gameState.phase === 'in-progress'
    );
    
    for (const code of roomsToCheck) {
        const room = rooms.get(code);
        if (!room) continue;
        
        // Get players in this specific room (including disconnected players during grace period)
        const roomPlayerIds = Array.from(room.players.keys());
        const disconnectedPlayerIds = Array.from(room.disconnectedPlayers.keys());
        const allRoomPlayerIds = [...roomPlayerIds, ...disconnectedPlayerIds];
        const activePlayers = roomPlayerIds.filter(id => players[id] && !players[id].eliminated);
        
        if (activePlayers.length <= 1) {
            const winnerId = activePlayers.length === 1 ? activePlayers[0] : null;
            
            console.log(`Match ended in room ${code}! Winner: ${winnerId || 'None (draw)'}`);
            
            // Set room phase to game-over to allow new players to join for next game
            room.gameState.phase = 'game-over';
            room.gameState.matchInProgress = false;
            
            // Prepare final stats for players in this room only (including disconnected players)
            const playerStats = allRoomPlayerIds.map(id => {
                const player = players[id];
                const disconnectedData = room.disconnectedPlayers.get(id);
                const playerSocket = io.sockets.sockets.get(id);
                
                if (!player && disconnectedData) {
                    // Player disconnected during game - use stored data and mark as DQ
                    const storedPlayer = disconnectedData.playerData;
                    const disconnectedSocket = disconnectedData.socket;
                    return {
                        playerId: id,
                        playerName: disconnectedSocket ? getPlayerDisplayName(disconnectedSocket) : `Player ${id.substring(0, 8)}...`,
                        lives: storedPlayer ? storedPlayer.lives : 0,
                        eliminated: true,
                        isWinner: false,
                        kills: storedPlayer ? (storedPlayer.kills || 0) : 0,
                        deaths: storedPlayer ? (storedPlayer.deaths || 0) : 0,
                        kdr: storedPlayer && storedPlayer.deaths > 0 ? (storedPlayer.kills / storedPlayer.deaths).toFixed(2) : (storedPlayer ? storedPlayer.kills.toString() : '0'),
                        disconnected: true,
                        rank: 'DQ'
                    };
                } else if (!player) {
                    // Player disconnected and no data - fallback
                    return {
                        playerId: id,
                        playerName: playerSocket ? getPlayerDisplayName(playerSocket) : `Player ${id.substring(0, 8)}...`,
                        lives: 0,
                        eliminated: true,
                        isWinner: false,
                        kills: 0,
                        deaths: 0,
                        kdr: '0.00',
                        disconnected: true,
                        rank: 'DQ'
                    };
                } else {
                    // Active player
                    return {
                        playerId: id,
                        playerName: playerSocket ? getPlayerDisplayName(playerSocket) : `Player ${id.substring(0, 8)}...`,
                        lives: player.lives,
                        eliminated: player.eliminated,
                        isWinner: id === winnerId,
                        kills: player.kills || 0,
                        deaths: player.deaths || 0,
                        // Calculate K/D ratio
                        kdr: player.deaths > 0 ? (player.kills / player.deaths).toFixed(2) : player.kills.toString(),
                        disconnected: false
                    };
                }
            });
            
            // Sort by: winner first, then by disconnected status (DQ last), then by kills, then by lowest deaths
            playerStats.sort((a, b) => {
                if (a.isWinner !== b.isWinner) return b.isWinner - a.isWinner;
                if (a.disconnected !== b.disconnected) return a.disconnected - b.disconnected; // DQ last
                if (a.kills !== b.kills) return b.kills - a.kills;
                return a.deaths - b.deaths;
            });
            
            // Update player stats in Firestore for authenticated users
            playerStats.forEach(async (stats) => {
                const playerSocket = io.sockets.sockets.get(stats.playerId);
                if (playerSocket) {
                    await updatePlayerStatsInFirestore(stats.playerId, playerSocket, stats);
                } else if (room.disconnectedPlayers.has(stats.playerId)) {
                    // Handle disconnected players
                    const disconnectedData = room.disconnectedPlayers.get(stats.playerId);
                    if (disconnectedData.socket) {
                        await updatePlayerStatsInFirestore(stats.playerId, disconnectedData.socket, stats);
                    }
                }
            });
            
            // Emit game over event to this specific room only
            io.to(code).emit('gameOver', {
                winnerId: winnerId,
                winnerName: winnerId ? (playerStats.find(p => p.playerId === winnerId)?.playerName || 'Winner') : 'No Winner',
                playerStats: playerStats,
                totalPlayers: playerStats.length,
                roomCode: code,
                timestamp: Date.now()
            });
            
            console.log(`Game Over in room ${code}! Final Stats:`, playerStats);
        }
    }
}

// Reset match to start a new round
function resetMatch() {
    console.log('Resetting match for new round...');
    
    // Reset all players
    for (const playerId in players) {
        const player = players[playerId];
        player.lives = STARTING_LIVES;
        player.isDead = false;
        player.eliminated = false;
        player.isInvincible = false;
        player.health = player.maxHealth;
        
        // Respawn all players
        const spawnPlatforms = PLATFORMS.filter(p => p.type === PLATFORM_TYPES.SPAWN);
        const randomSpawnPlatform = spawnPlatforms[Math.floor(Math.random() * spawnPlatforms.length)];
        player.x = randomSpawnPlatform.x;
        player.y = PlatformUtils.getPlayerStandingY(randomSpawnPlatform);
        player.velocityX = 0;
        player.velocityY = 0;
        player.isGrounded = true;
        player.jumpsRemaining = 2;
    }
    
    // Emit match reset event to all rooms
    emitToAllRooms('matchReset', {
        message: 'New round starting!',
        timestamp: Date.now()
    });
    
    console.log('Match reset complete!');
}

// Helper function to reset a single player for a new game (used for rematch)
function resetPlayerForNewGame(player, playerId) {
    // Reset game state
    player.lives = STARTING_LIVES;
    player.isDead = false;
    player.eliminated = false;
    player.isInvincible = false;
    player.health = player.maxHealth;
    player.attacking = false;
    player.attackProcessed = false;
    player.blocking = false;
    player.isDashing = false;
    player.dashDirection = 0;
    player.dashVelocity = 0;
    
    // Reset stats for new game
    player.kills = 0;
    player.deaths = 0;
    player.lastAttacker = null;
    player.lastAttackTime = 0;
    
    // Respawn at random spawn platform
    const spawnPlatforms = PLATFORMS.filter(p => p.type === PLATFORM_TYPES.SPAWN);
    const randomSpawnPlatform = spawnPlatforms[Math.floor(Math.random() * spawnPlatforms.length)];
    player.x = randomSpawnPlatform.x;
    player.y = PlatformUtils.getPlayerStandingY(randomSpawnPlatform);
    player.velocityX = 0;
    player.velocityY = 0;
    player.isGrounded = true;
    player.jumpsRemaining = 2;
    player.droppingFromPlatform = null;
    
    console.log(`Player ${playerId} reset for new game - stats cleared, respawned at (${player.x}, ${player.y})`);
}

// Platform collision detection functions (now using PlatformUtils)

function getPlayerGroundState(player, droppingFromPlatformId = null) {
    let isGrounded = false;
    let groundY = GROUND_Y; // Default ground level
    let landedPlatform = null;
    
    // Check collision with all platforms
    for (const platform of PLATFORMS) {
        const playerBounds = PlatformUtils.getPlayerBounds(player);
        const platformBounds = PlatformUtils.getPlatformBounds(platform);
        
        // Check if player is horizontally aligned with platform
        const isHorizontallyOverlapping = playerBounds.left < platformBounds.right && 
                                         playerBounds.right > platformBounds.left;
        
        if (isHorizontallyOverlapping) {
            const platformTop = platform.y - platform.height / 2;
                            const playerBottom = player.y + 40; // Player height/2 = 40px (height=80)
            
            // Check if player is close enough to platform top (within reasonable landing distance)
            const distanceToTop = playerBottom - platformTop;
            const isNearPlatform =  distanceToTop >= -20 && distanceToTop <= 20; // 20px tolerance for landing
            
            if (isNearPlatform && player.velocityY >= 0) {
                // For one-way platforms, allow dropping through ONLY the specific platform being dropped from
                if (platform.type === PLATFORM_TYPES.ONE_WAY) {
                    // NEW — never collide with the platform we're dropping from
                    if (droppingFromPlatformId === platform.id) {
                        // still in the grace period: let the player pass completely through
                        continue; // <-- skip collision entirely
                    }
                    
                    if (player.y < platformTop) { // Player center is above platform top
                        isGrounded = true;
                        // Position player so bottom touches platform top
                        groundY = PlatformUtils.getPlayerStandingY(platform);
                        landedPlatform = platform;
                        break;
                    }
                } else {
                    // Solid platforms - can land from any direction (but usually from above)
                    isGrounded = true;
                    // Position player so bottom touches platform top
                    groundY = PlatformUtils.getPlayerStandingY(platform);
                    landedPlatform = platform;
                    break;
                }
            }
        }
    }
    
    // Remove hardcoded ground collision to allow fall-through deaths
    // Players should only collide with defined platforms, not an invisible floor
    
    // If player has fallen far enough below the platform he dropped from, clear flag
    if (droppingFromPlatformId &&
        player.y - PlatformUtils.getPlayerStandingY(
            PLATFORMS.find(p => p.id === droppingFromPlatformId)
        ) > 53) {           // 53 px = ⅔ of player height (80px)
        player.droppingFromPlatform = null;
    }
    
    return { isGrounded, groundY, platform: landedPlatform };
}

function validatePlayerPosition(player) {
    // Skip validation for dead or eliminated players (they'll be handled by death system)
    if (player.isDead || player.eliminated) {
        return true;
    }
    
    // Check if player is clipping through solid platforms (stuck inside)
    for (const platform of PLATFORMS) {
        if (platform.type === PLATFORM_TYPES.SOLID) {
            const playerBounds = PlatformUtils.getPlayerBounds(player);
            const platformBounds = PlatformUtils.getPlatformBounds(platform);
            
            // Check if player is fully inside platform (invalid state)
            if (PlatformUtils.rectanglesOverlap(playerBounds, platformBounds)) {
                const platformTop = platform.y - platform.height / 2;
                const platformBottom = platform.y + platform.height / 2;
                
                // If player center is inside platform vertically, it's invalid
                if (player.y > platformTop + 10 && player.y < platformBottom - 10) {
                    return false; // Player is clipping through platform
                }
            }
        }
    }
    
    return true;
}

function getNearestSpawnPoint(x, y) {
    // Get spawn platforms
    const spawnPlatforms = PLATFORMS.filter(p => p.type === PLATFORM_TYPES.SPAWN);
    
    if (spawnPlatforms.length === 0) {
        // Fallback to main ground platform if no spawn platforms
        const mainGround = PLATFORMS.find(p => p.id === 'ground-main');
        if (mainGround) {
            return { x: 400, y: PlatformUtils.getPlayerStandingY(mainGround) };
        }
        // Last resort fallback
        return { x: 400, y: 530 };
    }
    
    let nearestSpawn = spawnPlatforms[0];
    let shortestDistance = Infinity;
    
    spawnPlatforms.forEach(platform => {
        const spawnY = PlatformUtils.getPlayerStandingY(platform);
        const distance = Math.sqrt(
            Math.pow(platform.x - x, 2) + Math.pow(spawnY - y, 2)
        );
        if (distance < shortestDistance) {
            shortestDistance = distance;
            nearestSpawn = platform;
        }
    });
    
    return { 
        x: nearestSpawn.x, 
        y: PlatformUtils.getPlayerStandingY(nearestSpawn) 
    };
}

// Enhanced jump validation with anti-cheat measures
function validateJump(player, currentTime) {
    // Basic validations
    if (!player || player.health <= 0) return false;
    if (player.jumpsRemaining <= 0) return false;
    
    // Cooldown check (anti-spam)
    const JUMP_COOLDOWN = 200; // ms
    if (currentTime - player.lastJumpTime < JUMP_COOLDOWN) return false;
    
    // Anti-cheat: Prevent impossible jumps
    // If player is falling too fast, don't allow jump (prevents exploit)
    if (player.velocityY > 300) return false;
    
    // Anti-cheat: Validate player position (prevent teleport exploits)
    if (player.y < 0 || player.y > 1000) return false; // Updated for expanded canvas
    if (player.x < -300 || player.x > 1100) return false; // Allow movement in extended areas
    
    // Rate limiting: max 10 jumps per second per player
    if (!player.jumpHistory) player.jumpHistory = [];
    const oneSecondAgo = currentTime - 1000;
    player.jumpHistory = player.jumpHistory.filter(time => time > oneSecondAgo);
    if (player.jumpHistory.length >= 10) return false;
    
    return true;
}

// Perform jump with event broadcasting
function performJump(player, currentTime, socket) {
    const isFirstJump = player.jumpsRemaining === 2;
    const jumpVelocity = isFirstJump ? -550 : -450; // First jump stronger, improved responsiveness
    
    // Apply jump physics
    player.velocityY = jumpVelocity;
    player.jumpsRemaining--;
    player.isGrounded = false;
    player.lastJumpTime = currentTime;
    
    // Track jump for rate limiting
    if (!player.jumpHistory) player.jumpHistory = [];
    player.jumpHistory.push(currentTime);
    
    // Broadcast jump event to all clients for visual effects/audio
    const jumpEvent = {
        playerId: socket.id,
        jumpType: isFirstJump ? 'single' : 'double',
        position: { x: player.x, y: player.y },
        velocity: jumpVelocity,
        timestamp: currentTime
    };
    
            emitToPlayerRoom(socket.id, 'playerJump', jumpEvent);
}

// Enhanced dash validation with anti-cheat measures
function validateDash(player, currentTime) {
    // Basic validations
    if (!player || player.health <= 0) return false;
    
    // Cooldown check (anti-spam)
    if (currentTime - player.lastDashTime < DASH_COOLDOWN) return false;
    
    // Prevent dash while already dashing
    if (player.isDashing) return false;
    
    // Prevent dash during other actions that should block it
    if (player.attacking || player.blocking) return false;
    
    // Anti-cheat: Validate player position (prevent teleport exploits)
    if (player.y < 0 || player.y > 1000) return false; // Updated for expanded canvas
    if (player.x < -300 || player.x > 1100) return false; // Allow movement in extended areas
    
    // Check if player is in a valid state to dash (not falling too fast)
    if (Math.abs(player.velocityY) > 1000) return false; // Prevent dash during excessive fall
    
    // Rate limiting: max 5 dashes per second per player
    if (!player.dashHistory) player.dashHistory = [];
    const oneSecondAgo = currentTime - 1000;
    player.dashHistory = player.dashHistory.filter(time => time > oneSecondAgo);
    if (player.dashHistory.length >= 5) return false;
    
    // Burst protection: prevent more than 2 dashes in 200ms (prevents macro abuse)
    const twoHundredMsAgo = currentTime - 200;
    const recentDashes = player.dashHistory.filter(time => time > twoHundredMsAgo);
    if (recentDashes.length >= 2) return false;
    
    return true;
}

// Perform dash with physics and event broadcasting
function performDash(player, direction, currentTime, socket) {
    const dashDirection = direction === 'left' ? -1 : 1;
    
    // Apply dash physics
    player.isDashing = true;
    player.dashDirection = dashDirection;
    player.dashStartTime = currentTime;
    player.lastDashTime = currentTime;
    player.dashVelocity = DASH_VELOCITY * dashDirection;
    
    // Apply immediate velocity boost (combines with normal movement)
    player.velocityX += player.dashVelocity;
    
    // Track dash for rate limiting
    if (!player.dashHistory) player.dashHistory = [];
    player.dashHistory.push(currentTime);
    
    // Broadcast dash event to all clients for visual effects
    const dashEvent = {
        playerId: socket.id,
        direction: direction,
        position: { x: player.x, y: player.y },
        velocity: player.dashVelocity,
        timestamp: currentTime
    };
    
            emitToPlayerRoom(socket.id, 'playerDash', dashEvent);
    
    console.log(`Player ${socket.id} dashed ${direction} with velocity ${player.dashVelocity}`);
}

// Interrupt dash due to external factors (damage, collision, etc.)
function interruptDash(player, playerId, reason = 'unknown') {
    if (!player.isDashing) return false;
    
    player.isDashing = false;
    player.dashDirection = 0;
    player.dashVelocity = 0;
    
    console.log(`Player ${playerId} dash interrupted: ${reason}`);
    
    // Broadcast dash interruption to clients for visual cleanup
    const interruptEvent = {
        playerId: playerId,
        reason: reason,
        position: { x: player.x, y: player.y },
        timestamp: Date.now()
    };
    
        emitToPlayerRoom(playerId, 'dashInterrupted', interruptEvent);
    return true;
}

// Enhanced player state validation and correction
function validatePlayerDashState(player, playerId) {
    // Ensure dash state consistency
    if (player.isDashing) {
        const currentTime = Date.now();
        const dashElapsed = currentTime - player.dashStartTime;
        
        // Auto-cleanup stale dash states (safety net)
        if (dashElapsed > DASH_DURATION * 2) {
            console.log(`Warning: Stale dash state detected for player ${playerId}, auto-cleaning`);
            interruptDash(player, playerId, 'stale_state');
        }
        
        // Validate dash direction consistency
        if (player.dashDirection === 0 && player.isDashing) {
            console.log(`Warning: Invalid dash direction detected for player ${playerId}, interrupting`);
            interruptDash(player, playerId, 'invalid_direction');
        }
    }
    
    // Ensure velocity consistency with dash state
    if (!player.isDashing && Math.abs(player.dashVelocity) > 0) {
        player.dashVelocity = 0; // Clean up orphaned dash velocity
    }
}

// Input validation for network edge cases
function validateInputs(inputs) {
    // Check if inputs object exists and is valid
    if (!inputs || typeof inputs !== 'object') return false;
    
    // Validate each input type
    const validBooleanInputs = ['left', 'right', 'jump', 'attack', 'block', 'down', 'light', 'heavy', 'shield'];
    const validNumberInputs = ['seq']; // Sequence number for input ordering
    const validNullableInputs = ['dashDir']; // Dash direction: -1, 1, or null
    
    for (const key in inputs) {
        if (validBooleanInputs.includes(key)) {
            if (typeof inputs[key] !== 'boolean') return false;
        } else if (key === 'dash') {
            // Special validation for dash - can be boolean (mobile) or string (keyboard) or null
            if (inputs[key] !== null && 
                typeof inputs[key] !== 'boolean' && 
                typeof inputs[key] !== 'string') {
                return false;
            }
            // If string, must be valid direction
            if (typeof inputs[key] === 'string' && 
                inputs[key] !== 'left' && inputs[key] !== 'right') {
                return false;
            }
        } else if (validNumberInputs.includes(key)) {
            if (typeof inputs[key] !== 'number' || inputs[key] < 0) return false;
        } else if (validNullableInputs.includes(key)) {
            // dashDir can be -1, 1, or null
            if (inputs[key] !== null && inputs[key] !== -1 && inputs[key] !== 1) {
                return false;
            }
        } else {
            // Unknown input key - be permissive for backward compatibility
            continue;
        }
    }
    
    // Prevent impossible input combinations (anti-cheat)
    if (inputs.left && inputs.right) {
        // Both left and right can't be true (prevents speed exploits)
        return false;
    }
    
    return true;
}

// Normalize inputs to handle both legacy and new mobile controller formats
function normalizeInputs(raw, player) {
    const inputs = {
        // Movement
        left: !!raw.left,
        right: !!raw.right,
        up: !!raw.up,
        down: !!raw.down,
        jump: !!raw.jump || !!raw.up, // Support both jump and up for mobile
        
        // Combat actions (new mobile controller support)
        light: !!raw.light || !!raw.attack, // Map attack to light for backward compatibility
        heavy: !!raw.heavy,
        shield: !!raw.shield || !!raw.block, // Map block to shield for mobile
        
        // Dash system
        dash: !!raw.dash || (typeof raw.dash === 'string'), // Support both boolean and string dash
        dashDir: null,
        
        // Legacy support
        attack: !!raw.attack, // Keep for existing desktop clients
        block: !!raw.block,   // Keep for existing desktop clients
        
        // Sequence tracking
        seq: raw.seq || 0
    };
    
    // Handle dash direction logic
    if (inputs.dash) {
        if (typeof raw.dash === 'string') {
            // Legacy string-based dash direction
            inputs.dashDir = raw.dash === 'left' ? -1 : 1;
        } else if (raw.dashDir !== undefined) {
            // Mobile controller explicit direction
            inputs.dashDir = raw.dashDir;
        } else {
            // Fall back to last horizontal direction or current movement
            if (inputs.left) {
                inputs.dashDir = -1;
            } else if (inputs.right) {
                inputs.dashDir = 1;
            } else {
                inputs.dashDir = player.lastHorizontal || 1; // Default to right
            }
        }
    }
    
    // Track last horizontal movement for dash direction
    if (inputs.left) player.lastHorizontal = -1;
    else if (inputs.right) player.lastHorizontal = 1;
    
    return inputs;
}

// Helper function to get all players currently in active rooms
function getPlayersInActiveRooms() {
    const activeRoomPlayers = new Set();
    
    for (const [roomCode, room] of rooms.entries()) {
        if (room.isActive && room.players.size > 0) {
            for (const playerSocketId of room.players.keys()) {
                if (players[playerSocketId]) {
                    activeRoomPlayers.add(playerSocketId);
                }
            }
        }
    }
    
    return activeRoomPlayers;
}

// Helper function to update physics
function updatePhysics() {
    const deltaTime = 1 / currentTickRate; // Use actual tick rate, not fixed FRAME_RATE
    const activeRoomPlayers = getPlayersInActiveRooms();
    
    for (const playerId of activeRoomPlayers) {
        const player = players[playerId];
        if (!player) continue; // Safety check
        
        // Apply gravity
        player.velocityY += GRAVITY * deltaTime;
        
        // Cap maximum fall speed for more predictable physics
        const maxFallSpeed = 800;
        if (player.velocityY > maxFallSpeed) {
            player.velocityY = maxFallSpeed;
        }
        
        // Update position based on velocity
        player.x += player.velocityX * deltaTime; // Add horizontal movement
        player.y += player.velocityY * deltaTime;
        
        // Platform and ground collision detection
        const groundState = getPlayerGroundState(player, player.droppingFromPlatform);
        
        if (groundState.isGrounded) {
            // Reduced logging - only log major platform changes
            if (!player.isGrounded && Math.abs(player.y - groundState.groundY) > 20) {
                console.log(`Player ${playerId} landed on ${groundState.platform?.id || 'ground'}`);
            }
            
            player.y = groundState.groundY;
            player.velocityY = 0;
            
            // Reset jump state when landing
            if (!player.isGrounded) {
                player.isGrounded = true;
                player.jumpsRemaining = 2;
                
                // Reset drop-down state when landing on any platform
                player.droppingFromPlatform = null;
                
                // Emit platform landing event for visual effects to room
                emitToPlayerRoom(playerId, 'playerLanded', {
                    playerId: playerId,
                    position: { x: player.x, y: player.y },
                    timestamp: Date.now()
                });
            }
        } else {
            player.isGrounded = false;
        }
        
        // Allow players to move freely - no horizontal clamping for fall-off deaths
        // Players can now move beyond the 800px play area to fall off the sides
        
        // Validate player position for platform clipping only
        if (!validatePlayerPosition(player)) {
            // Only handle platform clipping - teleport to nearest spawn point
            const nearestSpawn = getNearestSpawnPoint(player.x, player.y);
            player.x = nearestSpawn.x;
            player.y = nearestSpawn.y;
            player.velocityX = 0;
            player.velocityY = 0;
            player.isGrounded = true;
            player.jumpsRemaining = 2;
            
            console.log(`Player ${playerId} position corrected due to platform clipping (${nearestSpawn.x}, ${nearestSpawn.y})`);
        }
        
        // Dash physics updates
        if (player.isDashing) {
            const currentTime = Date.now();
            const dashElapsed = currentTime - player.dashStartTime;
            
            // Check if dash duration has ended
            if (dashElapsed >= DASH_DURATION) {
                player.isDashing = false;
                player.dashDirection = 0;
                player.dashVelocity = 0;
                console.log(`Player ${playerId} dash completed`);
            } else {
                // Apply velocity decay during dash
                player.dashVelocity *= DASH_DECAY_RATE;
                
                // Apply dash movement (combines with normal movement)
                const dashMovement = player.dashVelocity * deltaTime;
                player.x += dashMovement;
                
                // Wall collision detection during dash (only for extreme boundaries)
                if (player.x <= -250 || player.x >= 1050) {
                    // Stop dash on extreme boundary collision
                    player.isDashing = false;
                    player.dashDirection = 0;
                    player.dashVelocity = 0;
                    player.x = Math.max(-250, Math.min(1050, player.x)); // Clamp position to extreme boundaries
                    console.log(`Player ${playerId} dash stopped by extreme boundary collision`);
                }
            }
        }
        
        // Validate and clean up dash state consistency
        validatePlayerDashState(player, playerId);
        
        // Heavy attack startup processing
        const now = Date.now();
        if (player.pendingHeavy && now >= player.heavyStartupEnd && !player.heavyConsumed) {
            performHeavyAttack(player, playerId, now);
            player.heavyConsumed = true;
            player.pendingHeavy = false;
        }
        
        // Handle invincibility timer
        if (player.isInvincible && Date.now() > player.invincibilityEndTime) {
            player.isInvincible = false;
            console.log(`Player ${playerId} invincibility ended`);
            
            // Emit invincibility end event
                    emitToPlayerRoom(playerId, 'playerInvincibilityEnd', {
            playerId: playerId,
            timestamp: Date.now()
        });
        }
        
        // Check for health-based death (when health reaches 0)
        if (player.health <= 0 && !player.isDead && !player.eliminated) {
            console.log(`Player ${playerId} died from health depletion!`);
            
            // Trigger death with the same logic as fall-off death
            player.lives--;
            player.deaths++;
            player.isDead = true;
            player.deathTime = Date.now();
            
            // Check if death should be attributed to another player (kill attribution)
            const KILL_ATTRIBUTION_WINDOW = 5000; // 5 seconds
            let killerMessage = '';
            if (player.lastAttacker && 
                player.lastAttackTime && 
                (Date.now() - player.lastAttackTime) < KILL_ATTRIBUTION_WINDOW &&
                players[player.lastAttacker] && 
                !players[player.lastAttacker].eliminated) {
                
                // Give kill credit to the attacker
                players[player.lastAttacker].kills++;
                killerMessage = ` (killed by ${player.lastAttacker})`;
                console.log(`${player.lastAttacker} gets a kill! Total kills: ${players[player.lastAttacker].kills}`);
            }
            
            console.log(`Player ${playerId} died from combat! Lives remaining: ${player.lives}, Total deaths: ${player.deaths}${killerMessage}`);
            
            // Check if player is eliminated (no lives left)
            if (player.lives <= 0) {
                player.eliminated = true;
                console.log(`Player ${playerId} eliminated!`);
                
                // Emit elimination event to room
                emitToPlayerRoom(playerId, 'playerEliminated', {
                    playerId: playerId,
                    finalPosition: { x: player.x, y: player.y },
                    timestamp: Date.now()
                });
                
                // Check for match end in the player's room
                const roomInfo = getRoomByPlayer(playerId);
                if (roomInfo) {
                    checkMatchEnd(roomInfo.code);
                }
            } else {
                // Schedule respawn for combat death
                setTimeout(() => {
                    if (players[playerId] && !players[playerId].eliminated) {
                        respawnPlayer(players[playerId], playerId);
                    }
                }, RESPAWN_DELAY);
            }
            
            // Emit death event to room
            emitToPlayerRoom(playerId, 'playerDeath', {
                playerId: playerId,
                livesRemaining: player.lives,
                deathPosition: { x: player.x, y: player.y },
                isEliminated: player.eliminated,
                timestamp: Date.now()
            });
        }
        
        // Check for player death (fall-off boundaries)
        checkPlayerDeath(player, playerId);
        
        // Cleanup old jump history to prevent memory leaks
        if (player.jumpHistory) {
            const fiveSecondsAgo = Date.now() - 5000;
            player.jumpHistory = player.jumpHistory.filter(time => time > fiveSecondsAgo);
        }
        
        // Cleanup old dash history to prevent memory leaks
        if (player.dashHistory) {
            const fiveSecondsAgo = Date.now() - 5000;
            player.dashHistory = player.dashHistory.filter(time => time > fiveSecondsAgo);
        }
    }
}

// Helper function to handle combat
function handleCombat() {
    const activeRoomPlayers = getPlayersInActiveRooms();
    
    for (const attackerId of activeRoomPlayers) {
        const attacker = players[attackerId];
        if (!attacker) continue; // Safety check
        
        if (attacker.attacking && !attacker.attackProcessed) {
            // Check for hits against other players in the same room
            const attackerRoomInfo = getRoomByPlayer(attackerId);
            if (!attackerRoomInfo) continue;
            
            for (const targetId of attackerRoomInfo.room.players.keys()) {
                if (attackerId === targetId) continue;
                
                const target = players[targetId];
                if (!target) continue; // Safety check
                const distance = getDistance(attacker, target);
                
                if (distance <= ATTACK_RANGE && target.health > 0 && !target.isDead && !target.eliminated && !target.isInvincible) {
                    // Calculate damage (reduced if blocking)
                    let damage = ATTACK_DAMAGE;
                    if (target.blocking) {
                        damage = Math.floor(damage * 0.3); // 70% damage reduction when blocking
                    }
                    
                    target.health = Math.max(0, target.health - damage);
                    
                    // Track last attacker for kill attribution (5 second window)
                    target.lastAttacker = attackerId;
                    target.lastAttackTime = Date.now();
                    
                    // Interrupt dash if target was dashing when hit
                    if (target.isDashing) {
                        interruptDash(target, targetId, 'damaged');
                    }
                    
                    // Knockback effect
                    const knockbackDistance = 20;
                    const angle = Math.atan2(target.y - attacker.y, target.x - attacker.x);
                    target.x += Math.cos(angle) * knockbackDistance;
                    target.y += Math.sin(angle) * knockbackDistance;
                    
                    // Keep players in reasonable bounds (allow some overshoot for knockback)
                    target.x = Math.max(-200, Math.min(1000, target.x));
                    target.y = Math.max(25, Math.min(975, target.y));
                    
                    console.log(`${attackerId} hit ${targetId} for ${damage} damage. Target health: ${target.health}`);
                }
            }
            
            attacker.attackProcessed = true;
        }
    }
}

// Add authentication middleware for Socket.IO
io.use(socketAuthMiddleware);

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);
    
    // Spawn player at platform spawn point
    const spawnPlatforms = PLATFORMS.filter(p => p.type === PLATFORM_TYPES.SPAWN);
    const randomSpawnPlatform = spawnPlatforms[Math.floor(Math.random() * spawnPlatforms.length)];
    const spawnX = randomSpawnPlatform.x;
    const spawnY = PlatformUtils.getPlayerStandingY(randomSpawnPlatform);
    
    players[socket.id] = {
        x: spawnX,
        y: spawnY,
        velocityX: 0,
        velocityY: 0,
        health: 100,
        maxHealth: 100,
        attacking: false,
        attackProcessed: false,
        blocking: false,
        lastAttackTime: 0,
        isGrounded: true,
        jumpsRemaining: 2, // Allow double jump
        lastJumpTime: 0,
        droppingFromPlatform: null, // ID of the specific platform player is dropping from
        // Dash system properties
        isDashing: false,
        dashDirection: 0, // -1 for left, 1 for right, 0 for none
        dashStartTime: 0,
        lastDashTime: 0,
        dashVelocity: 0,
        // Lives and death system properties
        lives: STARTING_LIVES,
        isDead: false,
        isInvincible: false,
        invincibilityEndTime: 0,
        deathTime: 0,
        eliminated: false,
        // Stats tracking
        kills: 0,
        deaths: 0,
        lastAttacker: null,
        lastAttackTime: 0,
        // Character appearance (assigned when joining a room)
        character: null,
        characterTint: 0xffffff,
        // Player identity
        displayName: getPlayerDisplayName(socket),
        
        // Mobile controller support
        controlMode: 'keyboard', // 'keyboard' | 'controller'
        lastSeq: 0, // Last processed sequence number
        lastHorizontal: 1, // Last horizontal direction (-1 left, 1 right) for dash
        
        // Separate attack cooldown timers for mobile controller
        lastLightAttackTime: 0,
        lastHeavyAttackTime: 0,
        
        // Heavy attack state management
        pendingHeavy: false,
        heavyStartupEnd: 0,
        heavyConsumed: false
    };
    
    // Send empty initial game state (players will get real state after joining a room)
    socket.emit('gameState', { 
        players: {}, 
        platforms: PLATFORMS, // Send platforms once on initial connection
        serverTime: Date.now(),
        tick: 0,
        roomCode: null,
        playerCount: 0
    });
    
    // ==================== ROOM MANAGEMENT EVENT HANDLERS ====================
    
    // Handle room creation
    socket.on('createRoom', (callback) => {
        try {
            // Check if player is already in a room
            const existingRoom = getRoomByPlayer(socket.id);
            if (existingRoom) {
                return callback({ 
                    success: false, 
                    error: 'Already in a room. Leave current room first.' 
                });
            }
            
            // Create new room
            const room = createRoom(socket.id);
            
            // Join the Socket.IO room
            socket.join(room.code);
            
            // Add player to room
            room.players.set(socket.id, {
                socketId: socket.id,
                isHost: true,
                joinedAt: Date.now()
            });
            
            // Store room code on socket for easy access
            socket.roomCode = room.code;
            
            console.log(`Room ${room.code} created by ${socket.id}`);
            
            callback({ 
                success: true, 
                roomCode: room.code,
                isHost: true,
                playerCount: room.players.size,
                maxPlayers: ROOM_CONFIG.MAX_PLAYERS
            });
            
        } catch (error) {
            console.error('Error creating room:', error);
            callback({ 
                success: false, 
                error: 'Failed to create room. Please try again.' 
            });
        }
    });
    
    // Handle room joining
    socket.on('joinRoom', (data, callback) => {
        try {
            const { roomCode, playerName } = data;
            
            // Store player name if provided (from mobile controller)
            if (playerName && players[socket.id]) {
                players[socket.id].displayName = playerName.trim();
                console.log(`[MOBILE] Updated player ${socket.id} displayName to: ${playerName.trim()}`);
            }
            
            // Check if player is already in a room
            const existingRoom = getRoomByPlayer(socket.id);
            if (existingRoom) {
                return callback({ 
                    success: false, 
                    error: 'Already in a room. Leave current room first.' 
                });
            }
            
            // Attempt to join room
            const result = joinRoom(roomCode, socket.id, {
                socketId: socket.id,
                isHost: false,
                joinedAt: Date.now()
            });
            
            if (!result.success) {
                return callback({ 
                    success: false, 
                    error: result.error 
                });
            }
            
            // Join the Socket.IO room
            socket.join(result.room.code);
            socket.roomCode = result.room.code;
            
            if (result.rejoined) {
                // Player rejoined during grace period
                console.log(`Player ${socket.id} rejoined room ${result.room.code} during grace period`);
                
                // Notify other players that player rejoined
                socket.to(result.room.code).emit('playerRejoinedGame', {
                    socketId: socket.id,
                    playerCount: result.room.players.size,
                    message: 'Player reconnected! Game continues.'
                });
                
                callback({ 
                    success: true, 
                    roomCode: result.room.code,
                    isHost: result.room.hostId === socket.id,
                    playerCount: result.room.players.size,
                    maxPlayers: ROOM_CONFIG.MAX_PLAYERS,
                    hostId: result.room.hostId,
                    rejoined: true,
                    gameInProgress: true
                });
            } else {
                // Normal room join
                // Notify existing players in the room
                socket.to(result.room.code).emit('playerJoinedRoom', {
                    socketId: socket.id,
                    playerName: getPlayerDisplayName(socket),
                    playerCount: result.room.players.size,
                    maxPlayers: ROOM_CONFIG.MAX_PLAYERS
                });
                
                console.log(`Player ${socket.id} joined room ${result.room.code}`);
                
                callback({ 
                    success: true, 
                    roomCode: result.room.code,
                    isHost: false,
                    playerCount: result.room.players.size,
                    maxPlayers: ROOM_CONFIG.MAX_PLAYERS,
                    hostId: result.room.hostId
                });
            }
            
        } catch (error) {
            console.error('Error joining room:', error);
            callback({ 
                success: false, 
                error: 'Failed to join room. Please try again.' 
            });
        }
    });
    
    // Handle leaving room
    socket.on('leaveRoom', (callback) => {
        try {
            const roomInfo = getRoomByPlayer(socket.id);
            if (!roomInfo) {
                return callback({ 
                    success: false, 
                    error: 'Not in any room' 
                });
            }
            
            // Leave the Socket.IO room
            socket.leave(roomInfo.code);
            delete socket.roomCode;
            
            // Remove from room data structure
            const leftRoom = leaveRoom(socket.id);
            
            if (leftRoom) {
                // Notify remaining players
                socket.to(roomInfo.code).emit('playerLeftRoom', {
                    socketId: socket.id,
                    playerCount: leftRoom.players.size,
                    maxPlayers: ROOM_CONFIG.MAX_PLAYERS,
                    newHostId: leftRoom.hostId,
                    reason: 'disconnect'
                });
                
                console.log(`Player ${socket.id} disconnected from room ${roomInfo.code}`);
            }
            
            callback({ success: true });
            
        } catch (error) {
            console.error('Error leaving room:', error);
            callback({ 
                success: false, 
                error: 'Failed to leave room' 
            });
        }
    });
    
    // Handle getting room info
    socket.on('getRoomInfo', (callback) => {
        try {
            const roomInfo = getRoomByPlayer(socket.id);
            if (!roomInfo) {
                return callback({ 
                    success: false, 
                    error: 'Not in any room' 
                });
            }
            
            const playerList = Array.from(roomInfo.room.players.values()).map(p => {
                const playerSocket = io.sockets.sockets.get(p.socketId);
                return {
                    id: p.socketId,
                    socketId: p.socketId, // For backward compatibility
                    name: playerSocket ? getPlayerDisplayName(playerSocket) : `Player ${p.socketId.substring(0, 8)}...`,
                    isHost: p.socketId === roomInfo.room.hostId
                };
            });
            
            callback({ 
                success: true, 
                roomCode: roomInfo.code,
                isHost: roomInfo.room.hostId === socket.id,
                playerCount: roomInfo.room.players.size,
                maxPlayers: ROOM_CONFIG.MAX_PLAYERS,
                players: playerList,
                hostId: roomInfo.room.hostId
            });
            
        } catch (error) {
            console.error('Error getting room info:', error);
            callback({ 
                success: false, 
                error: 'Failed to get room info' 
            });
        }
    });
    
    // ==================== END ROOM MANAGEMENT EVENT HANDLERS ====================
    
    // Handle game start (host only)
    socket.on('startGame', (callback) => {
        try {
            const roomInfo = getRoomByPlayer(socket.id);
            if (!roomInfo) {
                return callback({ 
                    success: false, 
                    error: 'Not in any room' 
                });
            }
            
            // Check if player is host
            if (roomInfo.room.hostId !== socket.id) {
                return callback({ 
                    success: false, 
                    error: 'Only the host can start the game' 
                });
            }
            
            // Check minimum players (need at least 2 players)
            if (roomInfo.room.players.size < 2) {
                return callback({ 
                    success: false, 
                    error: 'Need at least 2 players to start a game' 
                });
            }
            
            console.log(`Host ${socket.id} starting game in room ${roomInfo.code} with ${roomInfo.room.players.size} players`);
            
            // Set room to countdown phase to prevent new players from joining
            roomInfo.room.gameState.phase = 'countdown';
            
            // Start 3-second countdown for all players in the room
            io.to(roomInfo.code).emit('gameStartCountdown', {
                countdown: 3,
                hostId: socket.id,
                playerCount: roomInfo.room.players.size,
                roomCode: roomInfo.code
            });
            
            // Countdown sequence: 3, 2, 1, GO!
            let countdownValue = 3;
            const countdownInterval = setInterval(() => {
                countdownValue--;
                
                if (countdownValue > 0) {
                    // Send countdown number
                    io.to(roomInfo.code).emit('gameStartCountdown', {
                        countdown: countdownValue,
                        hostId: socket.id,
                        playerCount: roomInfo.room.players.size,
                        roomCode: roomInfo.code
                    });
                } else {
                    // Countdown finished - start the game!
                    clearInterval(countdownInterval);
                    
                    // Set room phase to in-progress
                    roomInfo.room.gameState.phase = 'in-progress';
                    roomInfo.room.gameState.gameStarted = true;
                    roomInfo.room.gameState.matchInProgress = true;
                    
                    // Assign characters to all players in the room
                    const playerIds = Array.from(roomInfo.room.players.keys());
                    reassignRoomCharacters(roomInfo.code, playerIds);
                    
                    // Hide room UI and start game for all players in room
                    io.to(roomInfo.code).emit('gameStarted', {
                        message: 'Fight!',
                        hostId: socket.id,
                        playerCount: roomInfo.room.players.size,
                        roomCode: roomInfo.code,
                        timestamp: Date.now()
                    });
                    
                    // Update room activity
                    updateRoomActivity(roomInfo.code);
                    
                    console.log(`Game started in room ${roomInfo.code}!`);
                }
            }, 1000); // 1 second intervals
            
            callback({ 
                success: true, 
                message: 'Game starting...' 
            });
            
        } catch (error) {
            console.error('Error starting game:', error);
            callback({ 
                success: false, 
                error: 'Failed to start game' 
            });
        }
    });
    
    // Handle rematch (host only)
    socket.on('rematch', (callback) => {
        try {
            const roomInfo = getRoomByPlayer(socket.id);
            if (!roomInfo) {
                return callback({ 
                    success: false, 
                    error: 'Not in any room' 
                });
            }
            
            // Check if player is host
            if (roomInfo.room.hostId !== socket.id) {
                return callback({ 
                    success: false, 
                    error: 'Only the host can start a rematch' 
                });
            }
            
            console.log(`Host ${socket.id} starting rematch in room ${roomInfo.code}`);
            
            // Reset room game state for new match
            roomInfo.room.gameState.phase = 'countdown';
            roomInfo.room.gameState.gameStarted = false;
            roomInfo.room.gameState.matchInProgress = false;
            
            // Reset all players in the room for a new game
            for (const playerSocketId of roomInfo.room.players.keys()) {
                if (players[playerSocketId]) {
                    resetPlayerForNewGame(players[playerSocketId], playerSocketId);
                }
            }
            
            // Notify all players in room that rematch is starting
            io.to(roomInfo.code).emit('rematchStarting', {
                hostId: socket.id,
                playerCount: roomInfo.room.players.size,
                roomCode: roomInfo.code,
                message: 'Rematch starting...'
            });
            
            // Start countdown just like normal game start
            setTimeout(() => {
                io.to(roomInfo.code).emit('gameStartCountdown', {
                    countdown: 3,
                    hostId: socket.id,
                    playerCount: roomInfo.room.players.size,
                    roomCode: roomInfo.code
                });
                
                // Countdown sequence for rematch
                let countdownValue = 3;
                const countdownInterval = setInterval(() => {
                    countdownValue--;
                    
                    if (countdownValue > 0) {
                        io.to(roomInfo.code).emit('gameStartCountdown', {
                            countdown: countdownValue,
                            hostId: socket.id,
                            playerCount: roomInfo.room.players.size,
                            roomCode: roomInfo.code
                        });
                    } else {
                        clearInterval(countdownInterval);
                        
                        // Set room phase to in-progress for rematch
                        roomInfo.room.gameState.phase = 'in-progress';
                        roomInfo.room.gameState.gameStarted = true;
                        roomInfo.room.gameState.matchInProgress = true;
                        
                        // Reassign characters to all players in the room for rematch
                        const playerIds = Array.from(roomInfo.room.players.keys());
                        reassignRoomCharacters(roomInfo.code, playerIds);
                        
                        io.to(roomInfo.code).emit('gameStarted', {
                            message: 'Round 2, Fight!',
                            hostId: socket.id,
                            playerCount: roomInfo.room.players.size,
                            roomCode: roomInfo.code,
                            timestamp: Date.now()
                        });
                        
                        updateRoomActivity(roomInfo.code);
                        console.log(`Rematch started in room ${roomInfo.code}!`);
                    }
                }, 1000);
            }, 1000); // 1 second delay before countdown starts
            
            callback({ 
                success: true, 
                message: 'Rematch starting...' 
            });
            
        } catch (error) {
            console.error('Error starting rematch:', error);
            callback({ 
                success: false, 
                error: 'Failed to start rematch' 
            });
        }
    });
    
    // Handle return to lobby (any player can do this)
    socket.on('returnToLobby', (callback) => {
        try {
            const roomInfo = getRoomByPlayer(socket.id);
            if (!roomInfo) {
                return callback({ 
                    success: false, 
                    error: 'Not in any room' 
                });
            }
            
            console.log(`Player ${socket.id} returning to lobby in room ${roomInfo.code}`);
            
            // Reset room to lobby state (game is over, ready for new players)
            roomInfo.room.gameState.phase = 'lobby';
            roomInfo.room.gameState.gameStarted = false;
            roomInfo.room.gameState.matchInProgress = false;
            
            // Reset the player's game state but keep them in the room
            if (players[socket.id]) {
                resetPlayerForNewGame(players[socket.id], socket.id);
            }
            
            // Notify just this player to return to lobby and show room modal
            socket.emit('returnedToLobby', {
                roomCode: roomInfo.code,
                isHost: roomInfo.room.hostId === socket.id,
                playerCount: roomInfo.room.players.size,
                maxPlayers: ROOM_CONFIG.MAX_PLAYERS,
                message: 'Returned to lobby'
            });
            
            // Also emit roomJoined to trigger the room modal display
            socket.emit('roomJoined', {
                roomCode: roomInfo.code,
                isHost: roomInfo.room.hostId === socket.id,
                playerCount: roomInfo.room.players.size,
                maxPlayers: ROOM_CONFIG.MAX_PLAYERS,
                players: Array.from(roomInfo.room.players.values()).map(p => ({
                    id: p.socketId,
                    name: `Player ${p.socketId.substring(0, 8)}...`,
                    isHost: p.socketId === roomInfo.room.hostId
                }))
            });
            
            console.log(`Player ${socket.id} returned to lobby. Current host: ${roomInfo.room.hostId}, Is this player host: ${roomInfo.room.hostId === socket.id}`);
            
            // Notify all other players in the room about the updated room state
            socket.to(roomInfo.code).emit('playerReturnedToLobby', {
                playerId: socket.id,
                playerName: getPlayerDisplayName(socket),
                roomCode: roomInfo.code,
                playerCount: roomInfo.room.players.size,
                players: Array.from(roomInfo.room.players.values()).map(p => {
                    const playerSocket = io.sockets.sockets.get(p.socketId);
                    return {
                        id: p.socketId,
                        name: playerSocket ? getPlayerDisplayName(playerSocket) : `Player ${p.socketId.substring(0, 8)}...`,
                        isHost: p.socketId === roomInfo.room.hostId
                    };
                })
            });
            
            callback({ 
                success: true, 
                message: 'Returned to lobby' 
            });
            
        } catch (error) {
            console.error('Error returning to lobby:', error);
            callback({ 
                success: false, 
                error: 'Failed to return to lobby' 
            });
        }
    });
    
    // Handle authentication after initial connection
    socket.on('authenticate', async (data, callback) => {
        try {
            const { token } = data;
            console.log(`[AUTH] Received authentication request from socket ${socket.id}`);
            
            if (!token) {
                console.log(`[AUTH] No token provided`);
                if (callback) callback({ success: false, error: 'No token provided' });
                return;
            }

            // Verify token using existing auth manager
            const firebaseResult = await serverAuthManager.verifyIdToken(token);
            if (firebaseResult.success) {
                socket.user = firebaseResult.user;
                console.log(`[AUTH] Socket ${socket.id} authenticated successfully:`);
                console.log(`[AUTH] - UID: ${socket.user.uid}`);
                console.log(`[AUTH] - Display Name: ${socket.user.displayName}`);
                console.log(`[AUTH] - Is Guest: ${socket.user.isGuest}`);
                console.log(`[AUTH] - Is Anonymous: ${socket.user.isAnonymous}`);
                
                // Update player displayName if player exists
                if (players[socket.id]) {
                    players[socket.id].displayName = getPlayerDisplayName(socket);
                    console.log(`[AUTH] Updated player displayName to: ${players[socket.id].displayName}`);
                }
                
                if (callback) {
                    callback({ 
                        success: true, 
                        user: {
                            uid: socket.user.uid,
                            displayName: socket.user.displayName,
                            email: socket.user.email
                        }
                    });
                }
            } else {
                console.log(`[AUTH] Token verification failed for socket ${socket.id}:`, firebaseResult.error);
                if (callback) callback({ success: false, error: firebaseResult.error });
            }
        } catch (error) {
            console.error(`[AUTH] Authentication error for socket ${socket.id}:`, error);
            if (callback) callback({ success: false, error: error.message });
        }
    });

    socket.on('input', (rawInputs) => {
        const now = Date.now(); // Move this to the top to prevent ReferenceError
        const player = players[socket.id];
        if (!player || player.health <= 0 || player.isDead || player.eliminated) return;
        
        // Check if player is in an active room
        const roomInfo = getRoomByPlayer(socket.id);
        if (!roomInfo) {
            // Rate-limited logging for "not in room" to prevent spam
            if (!socket.lastNoRoomWarning || (now - socket.lastNoRoomWarning) > 5000) {
                console.log(`Input ignored: Player ${socket.id} not in any room (will suppress for 5s)`);
                socket.lastNoRoomWarning = now;
            }
            return;
        }
        
        const gamePhase = roomInfo.room.gameState.phase;
        
        // Allow inputs during 'countdown' and 'in-progress' phases
        // Block inputs only during 'lobby' and 'game-over' phases for mobile controller testing
        if (gamePhase === 'game-over') {
            console.log(`Input ignored: Game over phase for player ${socket.id}`);
            return;
        }
        
        // Input validation for network edge cases
        if (!validateInputs(rawInputs)) {
            // Rate-limited logging for validation failures to prevent spam
            if (!socket.lastValidationWarning || (now - socket.lastValidationWarning) > 10000) {
                console.log(`Input validation failed for player ${socket.id} (will suppress for 10s):`, rawInputs);
                socket.lastValidationWarning = now;
            }
            return;
        }
        
        // Normalize inputs to handle both legacy and mobile controller formats
        const inputs = normalizeInputs(rawInputs, player);
        
        // Debug logging for mobile controller - only log meaningful inputs
        if (inputs.seq > 0) {
            const hasMovement = inputs.left || inputs.right || inputs.up || inputs.down;
            const hasActions = inputs.light || inputs.heavy || inputs.shield || inputs.dash;
            
            if (hasMovement || hasActions) {
                console.log(`Mobile controller input from ${socket.id} (phase: ${gamePhase}):`, {
                    movement: { left: inputs.left, right: inputs.right, up: inputs.up, down: inputs.down },
                    actions: { light: inputs.light, heavy: inputs.heavy, shield: inputs.shield, dash: inputs.dash },
                    seq: inputs.seq
                });
            }
        }
        
        // Sequence number validation to prevent out-of-order inputs
        if (inputs.seq > 0) {
            if (inputs.seq <= player.lastSeq) {
                // Rate-limited logging for sequence issues to prevent spam
                if (!socket.lastSequenceWarning || (now - socket.lastSequenceWarning) > 10000) {
                    console.log(`Input ignored: Out of order sequence ${inputs.seq} <= ${player.lastSeq} for player ${socket.id} (will suppress for 10s)`);
                    socket.lastSequenceWarning = now;
                }
                return; // Ignore old or duplicate inputs
            }
            player.lastSeq = inputs.seq;
        }
        
        // Horizontal movement (velocity-based, frequency-independent)
        const baseSpeed = 120; // pixels per second
        const moveSpeed = player.blocking ? baseSpeed * 0.5 : baseSpeed;
        
        if (inputs.left) {
            player.velocityX = -moveSpeed;
        } else if (inputs.right) {
            player.velocityX = moveSpeed;
        } else {
            player.velocityX = 0;
        }
        
        // Jump handling with enhanced validation and anti-cheat
        if (inputs.jump && validateJump(player, now)) {
            performJump(player, now, socket);
        }
        
        // Enhanced dash handling for both legacy and mobile controller systems
        if (inputs.dash) {
            let dashDirection = null;
            let dashSource = 'unknown';
            
            // Mobile controller dash: explicit dashDir
            if (inputs.dashDir) {
                dashDirection = inputs.dashDir === -1 ? 'left' : 'right';
                dashSource = 'mobile_controller';
            }
            // Legacy desktop dash: string-based direction
            else if (typeof rawInputs.dash === 'string') {
                dashDirection = rawInputs.dash; // 'left' or 'right'
                dashSource = 'desktop_legacy';
            }
            
            // Perform dash if direction is determined and validation passes
            if (dashDirection && validateDash(player, now)) {
                performDash(player, dashDirection, now, socket);
                console.log(`Player ${socket.id} dashed ${dashDirection} via ${dashSource} (lastHorizontal: ${player.lastHorizontal})`);
            } else if (dashDirection) {
                console.log(`Player ${socket.id} dash ${dashDirection} blocked by validation (cooldown remaining: ${DASH_COOLDOWN - (now - player.lastDashTime)}ms)`);
            }
        }
        
        // Drop-down handling for one-way platforms
        if (inputs.down && player.isGrounded) {
            // Check if player is standing on a one-way platform
            const currentGroundState = getPlayerGroundState(player, null); // Pass null to check all platforms
            if (currentGroundState.platform && currentGroundState.platform.type === PLATFORM_TYPES.ONE_WAY) {
                console.log(`Player ${socket.id} dropping through one-way platform ${currentGroundState.platform.id}`);
                player.droppingFromPlatform = currentGroundState.platform.id; // Store the platform ID
                player.isGrounded = false;
                player.velocityY = 50; // Small downward velocity to start falling
                
                // Reset drop-down state after a short time
                setTimeout(() => {
                    if (players[socket.id]) {
                        players[socket.id].droppingFromPlatform = null; // Clear the platform ID
                    }
                }, 300); // 300ms to complete drop
            }
        }
        
        // Enhanced Blocking/Shield handling with logging
        const wasBlocking = player.blocking;
        player.blocking = inputs.shield || inputs.block; // Support both shield and legacy block
        
        // Log shield state changes for mobile controller debugging
        if (player.blocking !== wasBlocking && inputs.shield) {
            console.log(`Player ${socket.id} ${player.blocking ? 'activated' : 'deactivated'} shield (mobile controller)`);
        }
        
        // Light attack handling
        if (inputs.light && !player.attacking && (now - player.lastLightAttackTime) >= LIGHT_COOLDOWN) {
            triggerLightAttack(player, socket.id, now);
        }
        
        // Heavy attack handling with startup gating
        if (inputs.heavy && (now - player.lastHeavyAttackTime) >= HEAVY_COOLDOWN && !player.pendingHeavy) {
            triggerHeavyAttack(player, socket.id, now);
        }
        
        // Legacy attack handling (for backward compatibility)
        if (inputs.attack && !inputs.light && !inputs.heavy && !player.attacking && now - player.lastAttackTime > 500) {
            triggerLightAttack(player, socket.id, now); // Map legacy attack to light attack
        }
    });
    
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        
        // Get room info before cleaning up player
        const roomInfo = getRoomByPlayer(socket.id);
        if (roomInfo) {
            const room = roomInfo.room;
            const playerName = roomInfo.room.players.get(socket.id)?.displayName || socket.id;
            
            // Handle mid-game disconnection with grace period
            if (room.gameState.phase === 'in-progress' && room.players.size === 2) {
                console.log(`Mid-game disconnection in room ${roomInfo.code} - starting 10 second grace period`);
                
                // Store disconnected player data for potential rejoin
                room.disconnectedPlayers.set(socket.id, {
                    disconnectedAt: Date.now(),
                    playerData: players[socket.id],
                    socket: socket // Store socket reference for stats update
                });
                
                // Notify remaining player about grace period
                socket.to(roomInfo.code).emit('playerDisconnectedGracePeriod', {
                    disconnectedPlayerId: socket.id,
                    playerName: playerName,
                    gracePeriodSeconds: 10,
                    message: `${playerName} disconnected - 10 seconds to rejoin or you win!`
                });
                
                // Set 10-second timer
                room.disconnectionTimer = setTimeout(() => {
                    console.log(`Grace period expired in room ${roomInfo.code} - ending game`);
                    
                    // Clear disconnected players
                    room.disconnectedPlayers.clear();
                    room.disconnectionTimer = null;
                    
                    // Force game end with remaining player as winner
                    checkMatchEnd(roomInfo.code);
                }, 10000);
                
            } else {
                // Normal disconnection handling
                const leftRoom = leaveRoom(socket.id);
                
                if (leftRoom && leftRoom.players.size > 0) {
                    // Notify remaining players
                    socket.to(roomInfo.code).emit('playerLeftRoom', {
                        socketId: socket.id,
                        playerCount: leftRoom.players.size,
                        maxPlayers: ROOM_CONFIG.MAX_PLAYERS,
                        newHostId: leftRoom.hostId,
                        reason: 'disconnect'
                    });
                    
                    console.log(`Player ${socket.id} disconnected from room ${roomInfo.code}`);
                }
            }
        }
        
        // Remove player from global players object (only if not in grace period)
        const roomInfo2 = getRoomByPlayer(socket.id);
        if (!roomInfo2 || !roomInfo2.room.disconnectedPlayers.has(socket.id)) {
            // Clean up character assignment if player had one
            if (players[socket.id] && players[socket.id].character && roomInfo) {
                removeCharacterFromPlayer(socket.id, roomInfo.code, players[socket.id].character);
            }
            delete players[socket.id];
        }
    });
    
    // Latency measurement for debugging and optimization
    socket.on('ping', (timestamp) => {
        socket.emit('pong', timestamp);
    });
});

// Game loop - FIXED TICK RATE (optimized for high latency)
let currentTickRate = 30; // Fixed 30fps for network stability
let performanceStats = {
    avgExecutionTime: 0,
    lastMeasurement: Date.now(),
    sampleCount: 0
};

// Define gameLoop object for state tracking
const gameLoop = { tick: 0 };

function measureGameLoopPerformance(executionTime) {
    performanceStats.sampleCount++;
    performanceStats.avgExecutionTime = 
        (performanceStats.avgExecutionTime * (performanceStats.sampleCount - 1) + executionTime) / performanceStats.sampleCount;
    
    // Only log performance every 300 samples (~10 seconds)
    if (performanceStats.sampleCount % 300 === 0) {
        const totalRooms = rooms.size;
        const totalActivePlayers = Array.from(rooms.values()).reduce((sum, room) => sum + room.players.size, 0);
        
        console.log(`[PERF] Consistent 30fps | Avg exec: ${performanceStats.avgExecutionTime.toFixed(1)}ms | Players: ${totalActivePlayers} | Rooms: ${totalRooms} | DeltaTime: ${(1/currentTickRate).toFixed(4)}s`);
        
        // Reset stats
        performanceStats.avgExecutionTime = 0;
        performanceStats.sampleCount = 0;
    }
}

// Simplified game loop with consistent timing
function runGameLoop() {
    const startTime = Date.now();
    
    updatePhysics();
    handleCombat();
    
    // Send room-specific game states (optimized)
    for (const [roomCode, room] of rooms.entries()) {
        if (room.isActive && room.players.size > 0) {
            // Get only players in this room
            const roomPlayers = {};
            for (const playerSocketId of room.players.keys()) {
                if (players[playerSocketId]) {
                    roomPlayers[playerSocketId] = players[playerSocketId];
                }
            }
            
            // OPTIMIZED: Only send platforms on first connection or when requested
            const gameState = {
                players: roomPlayers,
                serverTime: Date.now(),
                tick: gameLoop.tick || 0,
                roomCode: roomCode,
                playerCount: room.players.size,
                tickRate: currentTickRate // Let clients know current tick rate
            };
            
            // Broadcast to this room only
            io.to(roomCode).emit('gameState', gameState);
            updateRoomActivity(roomCode);
        }
    }
    
    // Increment tick counter for debugging
    gameLoop.tick = (gameLoop.tick || 0) + 1;
    
    // Measure performance
    const executionTime = Date.now() - startTime;
    measureGameLoopPerformance(executionTime);
    
    // Fixed timing for consistent network behavior
    setTimeout(runGameLoop, 1000 / currentTickRate);
}

// Start the fixed game loop
console.log(`[GAME LOOP] Starting with consistent 30fps tick rate (deltaTime: ${(1/currentTickRate).toFixed(4)}s)`);
runGameLoop();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
}); 

// Add platform broadcasting optimization
function sendPlatformDataToPlayer(socket, roomCode) {
    const platformData = {
        platforms: PLATFORMS,
        roomCode: roomCode,
        eventType: 'platformData'
    };
    socket.emit('platformData', platformData);
    console.log(`[OPTIMIZATION] Sent platform data to player ${socket.id} in room ${roomCode}`);
}

// Helper function to send platforms to all players in a room (used rarely)
function sendPlatformDataToRoom(roomCode) {
    const platformData = {
        platforms: PLATFORMS,
        roomCode: roomCode,
        eventType: 'platformData'
    };
    io.to(roomCode).emit('platformData', platformData);
    console.log(`[OPTIMIZATION] Sent platform data to all players in room ${roomCode}`);
}

// Character assignment constants
const SAMURAI_CHARACTERS = ['samurai-1', 'samurai-4'];
const CHARACTER_TINT_COLORS = [
    0xffffff, // White (no tint) - first player with character
    0xAA44FF, // Purple - second player with same character
    0x44FF44, // Green - third player with same character
    0xFF44AA, // Pink - fourth player with same character
    0x4444FF, // Dark blue - fifth player with same character
    0x222222  // Dark gray/black - sixth player with same character
];

// Track character assignments per room
const roomCharacterAssignments = new Map(); // roomCode -> { characterName -> count }

// Function to assign character with tint for a player in a room
function assignCharacterToPlayer(playerId, roomCode) {
    // Use deterministic hash based on player ID to ensure consistency
    let hash = 0;
    for (let i = 0; i < playerId.length; i++) {
        const char = playerId.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32-bit integer
    }
    
    const characterIndex = Math.abs(hash) % SAMURAI_CHARACTERS.length;
    const assignedCharacter = SAMURAI_CHARACTERS[characterIndex];
    
    // Initialize room character tracking if needed
    if (!roomCharacterAssignments.has(roomCode)) {
        roomCharacterAssignments.set(roomCode, new Map());
    }
    
    const roomCharacters = roomCharacterAssignments.get(roomCode);
    const currentCount = roomCharacters.get(assignedCharacter) || 0;
    
    // Assign tint color based on how many players already have this character
    const tintColor = CHARACTER_TINT_COLORS[currentCount] || CHARACTER_TINT_COLORS[CHARACTER_TINT_COLORS.length - 1];
    
    // Increment counter for this character in this room
    roomCharacters.set(assignedCharacter, currentCount + 1);
    
    console.log(`[CHARACTER] Assigned ${assignedCharacter} to player ${playerId} in room ${roomCode} - duplicate #${currentCount + 1}, tint: 0x${tintColor.toString(16)}`);
    
    return {
        character: assignedCharacter,
        characterTint: tintColor
    };
}

// Function to remove character assignment when player leaves
function removeCharacterFromPlayer(playerId, roomCode, character) {
    if (!roomCharacterAssignments.has(roomCode)) return;
    
    const roomCharacters = roomCharacterAssignments.get(roomCode);
    if (!roomCharacters.has(character)) return;
    
    const currentCount = roomCharacters.get(character);
    if (currentCount <= 1) {
        roomCharacters.delete(character);
    } else {
        roomCharacters.set(character, currentCount - 1);
    }
    
    console.log(`[CHARACTER] Removed ${character} from player ${playerId} in room ${roomCode}`);
}

// Function to reassign all characters in a room (for consistency after disconnections)
function reassignRoomCharacters(roomCode, playerIds) {
    if (!roomCharacterAssignments.has(roomCode)) {
        roomCharacterAssignments.set(roomCode, new Map());
    }
    
    // Clear existing assignments for this room
    roomCharacterAssignments.get(roomCode).clear();
    
    // Reassign all players in order
    const assignments = {};
    for (const playerId of playerIds) {
        if (players[playerId]) {
            const assignment = assignCharacterToPlayer(playerId, roomCode);
            players[playerId].character = assignment.character;
            players[playerId].characterTint = assignment.characterTint;
            assignments[playerId] = assignment;
        }
    }
    
    console.log(`[CHARACTER] Reassigned characters in room ${roomCode} for ${playerIds.length} players`);
    return assignments;
}

// Mobile controller attack functions
function triggerLightAttack(player, playerId, now) {
    player.attacking = true;
    player.attackProcessed = false;
    player.lastLightAttackTime = now;
    player.lastAttackTime = now; // Keep for legacy compatibility
    
    // Emit attack event for visual feedback
    emitToPlayerRoom(playerId, 'attackEvent', { playerId, kind: 'light' });
    
    // Reset attack state after a short delay
    setTimeout(() => {
        if (players[playerId]) {
            players[playerId].attacking = false;
        }
    }, 200);
    
    console.log(`Player ${playerId} performed light attack`);
}

function triggerHeavyAttack(player, playerId, now) {
    player.pendingHeavy = true;
    player.heavyStartupEnd = now + HEAVY_STARTUP;
    player.heavyConsumed = false;
    player.lastHeavyAttackTime = now;
    
    // Emit attack charging event for visual feedback
    emitToPlayerRoom(playerId, 'attackCharging', { 
        playerId, 
        kind: 'heavy', 
        startup: HEAVY_STARTUP 
    });
    
    console.log(`Player ${playerId} started heavy attack (${HEAVY_STARTUP}ms startup)`);
}

function performHeavyAttack(player, playerId, now) {
    // Perform heavy hit detection similar to light but with heavy parameters
    const attackerRoomInfo = getRoomByPlayer(playerId);
    if (!attackerRoomInfo) return;
    
    for (const targetId of attackerRoomInfo.room.players.keys()) {
        if (playerId === targetId) continue;
        
        const target = players[targetId];
        if (!target) continue;
        
        const distance = getDistance(player, target);
        
        if (distance <= HEAVY_RANGE && target.health > 0 && !target.isDead && !target.eliminated && !target.isInvincible) {
            // Calculate heavy damage (reduced if blocking)
            let damage = HEAVY_DAMAGE;
            if (target.blocking) {
                damage = Math.floor(damage * 0.3); // 70% damage reduction when blocking
            }
            
            target.health = Math.max(0, target.health - damage);
            
            // Track last attacker for kill attribution
            target.lastAttacker = playerId;
            target.lastAttackTime = now;
            
            // Interrupt dash if target was dashing when hit
            if (target.isDashing) {
                interruptDash(target, targetId, 'damaged');
            }
            
            // Enhanced knockback for heavy attacks
            const knockbackDistance = 20 * HEAVY_KNOCKBACK_MULT;
            const angle = Math.atan2(target.y - player.y, target.x - player.x);
            target.x += Math.cos(angle) * knockbackDistance;
            target.y += Math.sin(angle) * knockbackDistance;
            
            // Keep players in reasonable bounds
            target.x = Math.max(-200, Math.min(1000, target.x));
            target.y = Math.max(25, Math.min(975, target.y));
            
            console.log(`${playerId} heavy attack hit ${targetId} for ${damage} damage. Target health: ${target.health}`);
        }
    }
    
    // Emit heavy attack execution event
    emitToPlayerRoom(playerId, 'attackEvent', { 
        playerId, 
        kind: 'heavy', 
        executed: true 
    });
    
    player.lastHeavyAttackTime = now;
    console.log(`Player ${playerId} executed heavy attack`);
}