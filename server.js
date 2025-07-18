const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const platformConfig = require('./public/platforms.js');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static('public')); // Serve index.html from 'public' directory

const players = {};

// Game constants
const ATTACK_RANGE = 70;
const ATTACK_DAMAGE = 15;
const MOVEMENT_SPEED = 6; // Increased by 1.5x for more responsive movement
const GRAVITY = 800;
const GROUND_Y = 560; // Ground level (600 - 40 for ground height)
const FRAME_RATE = 60;

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
const DASH_COOLDOWN = 350; // Cooldown between dashes in milliseconds (reduced from 500)
const DASH_DECAY_RATE = 0.85; // Velocity decay factor per frame (faster decay to prevent overshoot)

// Platform system
const { PLATFORMS, PLATFORM_TYPES, GAME_BOUNDS, PLATFORM_PHYSICS, PlatformUtils } = platformConfig;

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
        // Player has died - deduct a life
        player.lives--;
        player.isDead = true;
        player.deathTime = Date.now();
        
        console.log(`Player ${playerId} died! Lives remaining: ${player.lives}`);
        
        // Check if player is eliminated (no lives left)
        if (player.lives <= 0) {
            player.eliminated = true;
            console.log(`Player ${playerId} eliminated!`);
            
            // Emit elimination event
            io.emit('playerEliminated', {
                playerId: playerId,
                finalPosition: { x: player.x, y: player.y },
                timestamp: Date.now()
            });
            
            // Check for match end
            checkMatchEnd();
        } else {
            // Schedule respawn
            setTimeout(() => {
                if (players[playerId] && !players[playerId].eliminated) {
                    respawnPlayer(players[playerId], playerId);
                }
            }, RESPAWN_DELAY);
        }
        
        // Emit death event to all clients
        io.emit('playerDeath', {
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
    
    // Emit respawn event
    io.emit('playerRespawn', {
        playerId: playerId,
        position: { x: spawnX, y: spawnY },
        livesRemaining: player.lives,
        invincibilityDuration: INVINCIBILITY_DURATION,
        timestamp: Date.now()
    });
}

// Check if match should end (only one player remaining)
function checkMatchEnd() {
    const activePlayers = Object.keys(players).filter(id => !players[id].eliminated);
    
    if (activePlayers.length <= 1) {
        const winnerId = activePlayers.length === 1 ? activePlayers[0] : null;
        
        console.log(`Match ended! Winner: ${winnerId || 'None (draw)'}`);
        
        // Emit match end event
        io.emit('matchEnd', {
            winnerId: winnerId,
            finalStandings: Object.keys(players).map(id => ({
                playerId: id,
                lives: players[id].lives,
                eliminated: players[id].eliminated,
                isWinner: id === winnerId
            })),
            timestamp: Date.now()
        });
        
        // Reset match after a delay (optional)
        setTimeout(() => {
            resetMatch();
        }, 5000); // 5 second delay before reset
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
    
    // Emit match reset event
    io.emit('matchReset', {
        message: 'New round starting!',
        timestamp: Date.now()
    });
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
            const playerBottom = player.y + 30; // Player height/2 = 30px
            
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
        ) > 40) {           // 40 px = ⅔ of player height
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
    
    io.emit('playerDash', dashEvent);
    
    console.log(`Player ${socket.id} dashed ${direction} with velocity ${player.dashVelocity}`);
}

// Interrupt dash due to external factors (damage, collision, etc.)
function interruptDash(player, reason = 'unknown') {
    if (!player.isDashing) return false;
    
    player.isDashing = false;
    player.dashDirection = 0;
    player.dashVelocity = 0;
    
    console.log(`Player dash interrupted: ${reason}`);
    
    // Broadcast dash interruption to clients for visual cleanup
    const interruptEvent = {
        playerId: player.id || 'unknown',
        reason: reason,
        position: { x: player.x, y: player.y },
        timestamp: Date.now()
    };
    
    io.emit('dashInterrupted', interruptEvent);
    return true;
}

// Enhanced player state validation and correction
function validatePlayerDashState(player) {
    // Ensure dash state consistency
    if (player.isDashing) {
        const currentTime = Date.now();
        const dashElapsed = currentTime - player.dashStartTime;
        
        // Auto-cleanup stale dash states (safety net)
        if (dashElapsed > DASH_DURATION * 2) {
            console.log(`Warning: Stale dash state detected for player, auto-cleaning`);
            interruptDash(player, 'stale_state');
        }
        
        // Validate dash direction consistency
        if (player.dashDirection === 0 && player.isDashing) {
            console.log(`Warning: Invalid dash direction detected, interrupting`);
            interruptDash(player, 'invalid_direction');
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
    const validBooleanInputs = ['left', 'right', 'jump', 'attack', 'block', 'down'];
    const validStringInputs = ['dash']; // Dash can be 'left', 'right', or null
    
    for (const key in inputs) {
        if (validBooleanInputs.includes(key)) {
            if (typeof inputs[key] !== 'boolean') return false;
        } else if (validStringInputs.includes(key)) {
            // Dash input can be 'left', 'right', or null
            if (inputs[key] !== null && inputs[key] !== 'left' && inputs[key] !== 'right') {
                return false;
            }
        } else {
            // Unknown input key
            return false;
        }
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
        
        // Platform and ground collision detection
        const groundState = getPlayerGroundState(player, player.droppingFromPlatform);
        
        if (groundState.isGrounded) {
            // Only log significant state changes or initial landings
            if (!player.isGrounded && Math.abs(player.y - groundState.groundY) > 5) {
                console.log(`Player ${playerId} landed on ${groundState.platform?.id || 'ground'} at y=${groundState.groundY}`);
            }
            
            player.y = groundState.groundY;
            player.velocityY = 0;
            
            // Reset jump state when landing
            if (!player.isGrounded) {
                player.isGrounded = true;
                player.jumpsRemaining = 2;
                
                // Reset drop-down state when landing on any platform
                player.droppingFromPlatform = null;
                
                // Emit platform landing event for visual effects
                io.emit('playerLanded', {
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
        validatePlayerDashState(player);
        
        // Handle invincibility timer
        if (player.isInvincible && Date.now() > player.invincibilityEndTime) {
            player.isInvincible = false;
            console.log(`Player ${playerId} invincibility ended`);
            
            // Emit invincibility end event
            io.emit('playerInvincibilityEnd', {
                playerId: playerId,
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
    for (const attackerId in players) {
        const attacker = players[attackerId];
        
        if (attacker.attacking && !attacker.attackProcessed) {
            // Check for hits against other players
            for (const targetId in players) {
                if (attackerId === targetId) continue;
                
                const target = players[targetId];
                const distance = getDistance(attacker, target);
                
                if (distance <= ATTACK_RANGE && target.health > 0 && !target.isDead && !target.eliminated && !target.isInvincible) {
                    // Calculate damage (reduced if blocking)
                    let damage = ATTACK_DAMAGE;
                    if (target.blocking) {
                        damage = Math.floor(damage * 0.3); // 70% damage reduction when blocking
                    }
                    
                    target.health = Math.max(0, target.health - damage);
                    
                    // Interrupt dash if target was dashing when hit
                    if (target.isDashing) {
                        interruptDash(target, 'damaged');
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
        eliminated: false
    };
    
    // Send initial game state to new player
    socket.emit('gameState', { players });
    
    socket.on('input', (inputs) => {
        const player = players[socket.id];
        if (!player || player.health <= 0 || player.isDead || player.eliminated) return;
        
        // Input validation for network edge cases
        if (!validateInputs(inputs)) return;
        
        const now = Date.now();
        
        // Horizontal movement (slower when blocking) - allow movement beyond boundaries
        const moveSpeed = player.blocking ? MOVEMENT_SPEED * 0.5 : MOVEMENT_SPEED;
        
        if (inputs.left) {
            player.velocityX = -moveSpeed;
            player.x -= moveSpeed;
        } else if (inputs.right) {
            player.velocityX = moveSpeed;
            player.x += moveSpeed;
        } else {
            player.velocityX = 0;
        }
        
        // Jump handling with enhanced validation and anti-cheat
        if (inputs.jump && validateJump(player, now)) {
            performJump(player, now, socket);
        }
        
        // Dash handling with validation and cooldown
        if (inputs.dash && validateDash(player, now)) {
            performDash(player, inputs.dash, now, socket);
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
        platforms: PLATFORMS, // Include platform data for client synchronization
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