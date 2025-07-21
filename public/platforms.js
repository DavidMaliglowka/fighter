// Platform configuration for the fighting game
// This file defines the static platforms for multi-level gameplay

// Platform types
const PLATFORM_TYPES = {
    SOLID: 'SOLID',        // Cannot pass through from any direction
    ONE_WAY: 'ONE_WAY',    // Can only be landed on from above
    SPAWN: 'SPAWN'         // Spawn points (solid platforms)
};

// Platform colors for visual distinction
const PLATFORM_COLORS = {
    [PLATFORM_TYPES.SOLID]: 0x8B4513,    // Brown
    [PLATFORM_TYPES.ONE_WAY]: 0xF36D32,  // Orange  
    [PLATFORM_TYPES.SPAWN]: 0xFF8C00     // Orange
};

// Game boundaries
const GAME_BOUNDS = {
    LEFT: 0,
    RIGHT: 800,
    TOP: 0,
    BOTTOM: 600,
    PLAYER_MARGIN: 25
};

// Platform physics constants
const PLATFORM_PHYSICS = {
    PLAYER_WIDTH: 40,
    PLAYER_HEIGHT: 80,    // Back to 80 - the doubled sprites need this height for proper platform positioning
    ONE_WAY_VELOCITY_THRESHOLD: 0 // Must be falling to land on one-way platforms
};

// Platform definitions
// Fixed issues:
// 1. Single ground platform instead of left/right split
// 2. Proper positioning so player bottom touches platform top
// 3. Better mid-level platform placement
// 4. Correct green platform setup for landing from above
// 5. Spawn platforms are invisible but functional
// 6. Spawn platforms level with main ground
const PLATFORMS = [
    // Ground Level (Level 0) - Single continuous ground row
    {
        id: 'ground-main',
        type: PLATFORM_TYPES.SOLID,
        x: 400,        // Center of screen
        y: 580,        // Y position (platform center)
        width: 864,    // Full width
        height: 96,    // Single tile height (one row)
        level: 0
    },
    
    // Spawn platforms (invisible but functional for collision) - LEVEL WITH MAIN GROUND
    {
        id: 'spawn-left',
        type: PLATFORM_TYPES.SPAWN,
        x: 100,        // Left side
        y: 580,        // Same level as main ground
        width: 120,
        height: 96,    // Same height as main ground
        level: 0
    },
    {
        id: 'spawn-right', 
        type: PLATFORM_TYPES.SPAWN,
        x: 700,        // Right side
        y: 580,        // Same level as main ground
        width: 120,
        height: 96,    // Same height as main ground
        level: 0
    },
    
    // Mid Level (Level 1) - Better positioned for jumping
    {
        id: 'mid-center',
        type: PLATFORM_TYPES.SOLID,
        x: 400,        // Center
        y: 420,        // Higher up, easier to reach
        width: 150,    // Wider for easier landing
        height: 20,
        level: 1
    },
    {
        id: 'mid-left',
        type: PLATFORM_TYPES.ONE_WAY,
        x: 200,        // Left side
        y: 400,        // Slightly lower
        width: 120,    // 2 flags * 60px = proper spacing
        height: 64,
        level: 1
    },
    {
        id: 'mid-right',
        type: PLATFORM_TYPES.ONE_WAY, 
        x: 600,        // Right side
        y: 400,        // Slightly lower
        width: 120,    // 2 flags * 60px = proper spacing
        height: 64,
        level: 1
    },
    
    // Upper Level (Level 2) 
    {
        id: 'upper-left',
        type: PLATFORM_TYPES.ONE_WAY,
        x: 150,
        y: 280,        // High up
        width: 120,    // 2 flags * 60px = proper spacing
        height: 64,
        level: 2
    },
    {
        id: 'upper-right',
        type: PLATFORM_TYPES.ONE_WAY,
        x: 650,
        y: 280,        // High up  
        width: 120,    // 2 flags * 60px = proper spacing
        height: 64,
        level: 2
    },
    
    // Top Level (Level 3)
    {
        id: 'top-center',
        type: PLATFORM_TYPES.SOLID,
        x: 400,
        y: 160,        // Very high
        width: 80,
        height: 20,
        level: 3
    }
];

// Utility functions for platform interactions
const PlatformUtils = {
    // Check if a player can land on a one-way platform
    canLandOnOneWayPlatform: function(playerY, playerVelocityY, platform) {
        // Player must be falling (positive velocity) to land on one-way platforms
        return playerVelocityY >= PLATFORM_PHYSICS.ONE_WAY_VELOCITY_THRESHOLD;
    },
    
    // Get the platform a player should land on at a given position
    getPlatformAtPosition: function(x, y) {
        for (const platform of PLATFORMS) {
            const halfWidth = platform.width / 2;
            const halfHeight = platform.height / 2;
            
            if (x >= platform.x - halfWidth && 
                x <= platform.x + halfWidth &&
                y >= platform.y - halfHeight &&
                y <= platform.y + halfHeight) {
                return platform;
            }
        }
        return null;
    },
    
    // Get the correct Y position for a player to stand on a platform
    getPlayerStandingY: function(platform) {
        // Player center should be platform top + half player height
        const platformTop = platform.y - (platform.height / 2);
        return platformTop - (PLATFORM_PHYSICS.PLAYER_HEIGHT / 2);
    },
    
    // Check if two rectangles overlap (for collision detection)
    rectanglesOverlap: function(rect1, rect2) {
        return (rect1.left < rect2.right && 
                rect1.right > rect2.left && 
                rect1.top < rect2.bottom && 
                rect1.bottom > rect2.top);
    },
    
    // Get player bounding rectangle
    getPlayerBounds: function(player) {
        const halfWidth = PLATFORM_PHYSICS.PLAYER_WIDTH / 2;
        const halfHeight = PLATFORM_PHYSICS.PLAYER_HEIGHT / 2;
        
        return {
            left: player.x - halfWidth,
            right: player.x + halfWidth,
            top: player.y - halfHeight,
            bottom: player.y + halfHeight
        };
    },
    
    // Get platform bounding rectangle  
    getPlatformBounds: function(platform) {
        const halfWidth = platform.width / 2;
        const halfHeight = platform.height / 2;
        
        return {
            left: platform.x - halfWidth,
            right: platform.x + halfWidth,
            top: platform.y - halfHeight,
            bottom: platform.y + halfHeight
        };
    }
};

// Export for both Node.js (server) and browser
if (typeof module !== 'undefined' && module.exports) {
    // Node.js environment (server)
    module.exports = {
        PLATFORMS,
        PLATFORM_TYPES,
        PLATFORM_COLORS,
        GAME_BOUNDS,
        PLATFORM_PHYSICS,
        PlatformUtils
    };
} else {
    // Browser environment (client)
    window.PlatformConfig = {
        PLATFORMS,
        PLATFORM_TYPES,
        PLATFORM_COLORS,
        GAME_BOUNDS,
        PLATFORM_PHYSICS,
        PlatformUtils
    };
} 