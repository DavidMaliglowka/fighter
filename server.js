const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static('public')); // Serve index.html from 'public' directory

const players = {};

// Game constants
const ATTACK_RANGE = 70;
const ATTACK_DAMAGE = 15;
const MOVEMENT_SPEED = 4;
const GRAVITY = 800;
const GROUND_Y = 560; // Ground level (600 - 40 for ground height)
const FRAME_RATE = 60;

// Helper function to calculate distance between two points
function getDistance(player1, player2) {
    const dx = player1.x - player2.x;
    const dy = player1.y - player2.y;
    return Math.sqrt(dx * dx + dy * dy);
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
    if (player.y < 0 || player.y > 600) return false;
    if (player.x < 0 || player.x > 800) return false;
    
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
    const jumpVelocity = isFirstJump ? -500 : -400; // First jump stronger
    
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
    
    io.emit('playerJump', jumpEvent);
}

// Input validation for network edge cases
function validateInputs(inputs) {
    // Check if inputs object exists and is valid
    if (!inputs || typeof inputs !== 'object') return false;
    
    // Validate each input is a boolean (prevent injection attacks)
    const validInputs = ['left', 'right', 'jump', 'attack', 'block'];
    for (const key in inputs) {
        if (!validInputs.includes(key)) return false;
        if (typeof inputs[key] !== 'boolean') return false;
    }
    
    // Prevent impossible input combinations (anti-cheat)
    if (inputs.left && inputs.right) {
        // Both left and right can't be true (prevents speed exploits)
        return false;
    }
    
    return true;
}

// Helper function to update physics
function updatePhysics() {
    const deltaTime = 1 / FRAME_RATE;
    
    for (const playerId in players) {
        const player = players[playerId];
        
        // Apply gravity
        player.velocityY += GRAVITY * deltaTime;
        
        // Update position based on velocity
        player.y += player.velocityY * deltaTime;
        
        // Ground collision detection
        if (player.y >= GROUND_Y) {
            player.y = GROUND_Y;
            player.velocityY = 0;
            
            // Reset jump state when landing
            if (!player.isGrounded) {
                player.isGrounded = true;
                player.jumpsRemaining = 2;
            }
        } else {
            player.isGrounded = false;
        }
        
        // Keep players within horizontal bounds
        player.x = Math.max(25, Math.min(775, player.x));
        
        // Cleanup old jump history to prevent memory leaks
        if (player.jumpHistory) {
            const fiveSecondsAgo = Date.now() - 5000;
            player.jumpHistory = player.jumpHistory.filter(time => time > fiveSecondsAgo);
        }
    }
}

// Helper function to handle combat
function handleCombat() {
    for (const attackerId in players) {
        const attacker = players[attackerId];
        
        if (attacker.attacking && !attacker.attackProcessed) {
            // Check for hits against other players
            for (const targetId in players) {
                if (attackerId === targetId) continue;
                
                const target = players[targetId];
                const distance = getDistance(attacker, target);
                
                if (distance <= ATTACK_RANGE && target.health > 0) {
                    // Calculate damage (reduced if blocking)
                    let damage = ATTACK_DAMAGE;
                    if (target.blocking) {
                        damage = Math.floor(damage * 0.3); // 70% damage reduction when blocking
                    }
                    
                    target.health = Math.max(0, target.health - damage);
                    
                    // Knockback effect
                    const knockbackDistance = 20;
                    const angle = Math.atan2(target.y - attacker.y, target.x - attacker.x);
                    target.x += Math.cos(angle) * knockbackDistance;
                    target.y += Math.sin(angle) * knockbackDistance;
                    
                    // Keep players in bounds
                    target.x = Math.max(25, Math.min(775, target.x));
                    target.y = Math.max(25, Math.min(575, target.y));
                    
                    console.log(`${attackerId} hit ${targetId} for ${damage} damage. Target health: ${target.health}`);
                }
            }
            
            attacker.attackProcessed = true;
        }
    }
}

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);
    
    // Spawn player at random position
    const spawnX = 200 + Math.random() * 400;
    const spawnY = 300 + Math.random() * 200;
    
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
        lastJumpTime: 0
    };
    
    // Send initial game state to new player
    socket.emit('gameState', { players });
    
    socket.on('input', (inputs) => {
        const player = players[socket.id];
        if (!player || player.health <= 0) return;
        
        // Input validation for network edge cases
        if (!validateInputs(inputs)) return;
        
        const now = Date.now();
        
        // Horizontal movement (slower when blocking)
        const moveSpeed = player.blocking ? MOVEMENT_SPEED * 0.5 : MOVEMENT_SPEED;
        
        if (inputs.left && player.x > 25) {
            player.velocityX = -moveSpeed;
            player.x -= moveSpeed;
        } else if (inputs.right && player.x < 775) {
            player.velocityX = moveSpeed;
            player.x += moveSpeed;
        } else {
            player.velocityX = 0;
        }
        
        // Jump handling with enhanced validation and anti-cheat
        if (inputs.jump && validateJump(player, now)) {
            performJump(player, now, socket);
        }
        
        // Blocking
        player.blocking = inputs.block;
        
        // Attack (with cooldown)
        if (inputs.attack && !player.attacking && now - player.lastAttackTime > 500) {
            player.attacking = true;
            player.attackProcessed = false;
            player.lastAttackTime = now;
            
            // Reset attack state after a short delay
            setTimeout(() => {
                if (players[socket.id]) {
                    players[socket.id].attacking = false;
                }
            }, 200);
        }
    });
    
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        delete players[socket.id];
    });
});

// Game loop - 60 FPS
setInterval(() => {
    updatePhysics();
    handleCombat();
    
    // Enhanced game state with physics information
    const gameState = {
        players: players,
        serverTime: Date.now(),
        tick: gameLoop.tick || 0
    };
    
    io.emit('gameState', gameState);
    
    // Increment tick counter for debugging
    gameLoop.tick = (gameLoop.tick || 0) + 1;
}, 1000 / 60);

// Global game loop object for state tracking
const gameLoop = {};

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
}); 