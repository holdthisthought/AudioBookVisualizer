// Character Extraction CLI Module
// This module handles character extraction using CLI tools (Claude Code or Gemini CLI)
// instead of direct API calls

const fs = require('fs').promises;
const path = require('path');

/**
 * Builds the character extraction prompt with custom prompts
 * @param {string} transcript - The chapter transcript
 * @param {string} existingCharacters - JSON string of existing characters
 * @param {number} chapterNumber - The chapter number being processed
 * @param {object} customPrompts - Custom prompts from settings
 * @returns {string} The complete prompt for character extraction
 */
function buildCharacterExtractionPrompt(transcript, existingCharacters, chapterNumber, customPrompts, contextInfo = {}) {
    // Extract time period and location from context or use defaults
    const timePeriod = contextInfo.timePeriod || 'Not specified - YOU MUST DETERMINE FROM CONTEXT';
    const location = contextInfo.location || 'Not specified - YOU MUST DETERMINE FROM CONTEXT';
    
    return `You are an intelligent character database manager for an audiobook with advanced reasoning capabilities. Your task is to analyze chapter transcripts and maintain a comprehensive character database that tracks physical appearances and their evolution throughout the story.

CRITICAL CONTEXT INFORMATION:
Time Period: ${timePeriod}
Location/Setting: ${location}

These context parameters are ESSENTIAL for accurate character descriptions. If they are not specified, you MUST determine them from the transcript before describing any characters. The time period and location dramatically affect clothing, hairstyles, accessories, and overall appearance.

Here is the existing character database:
${existingCharacters}

Here is the transcript for Chapter ${chapterNumber}:
---
${transcript}
---

CRITICAL INSTRUCTIONS:

0. **CONTEXT AWARENESS - TIME PERIOD & LOCATION**
   - FIRST, identify or confirm the time period and location from the transcript
   - ALL character descriptions MUST be appropriate for the identified time period and location
   - Example: A senator in Ancient Rome (79 AD) would wear a toga, while a senator in 1970s Washington DC would wear a business suit
   - Clothing, hairstyles, accessories, and social conventions MUST match the time period and location
   - If the time period or location changes within the story, note this in the character's evolution

1. **Character Identification & Aliases**
   ${customPrompts.characterIdentification}

2. **Physical Description Building**
   ${customPrompts.physicalDescription}
   - CRITICAL: All clothing and appearance details MUST be period and location appropriate
   - Research typical dress for the character's social status in that specific time and place

3. **Character Evolution & Sub-Characteristics**
   ${customPrompts.characterEvolution}
   - Track if characters move between locations or time periods
   - Create new sub-characteristics when location/time changes affect appearance
   
4. **Detailed Appearance Descriptions**
   ${customPrompts.descriptionDetail}
   - Ensure all details match the current time period and location
   - Use historically/geographically accurate terminology

5. **Chapter Tracking**
   - For the main character entry: track all chapters where ANY version appears
   - For each sub-characteristic: track specific chapters where that version appears
   - This allows determining which version of a character is active in any given chapter

REQUIRED JSON STRUCTURE:
{
  "name": "Character Full Name",
  "parameters": {
    "identity": {
      "role": "e.g., Senator, Knight, Merchant, Scholar",
      "age": "e.g., 45, late 30s, elderly, young adult",
      "gender": "male/female/other"
    },
    "physicalBuild": {
      "height": "e.g., tall 6'2\", average 5'8\", short",
      "build": "e.g., athletic, slender, stocky, heavy-set, muscular",
      "posture": "e.g., upright military bearing, slouched, graceful"
    },
    "facialFeatures": {
      "skinTone": "e.g., olive, pale, dark, sun-weathered",
      "faceShape": "e.g., angular, round, oval, square",
      "eyes": "e.g., deep brown, piercing blue, green with gold flecks",
      "hair": "e.g., short black curls, long golden waves, gray shoulder-length",
      "facialHair": "e.g., full beard, clean-shaven, mustache, stubble",
      "distinctiveFeatures": "e.g., scar above left eye, birthmark on cheek, broken nose"
    },
    "attire": {
      "headwear": "e.g., laurel wreath, hood, crown, nothing",
      "upperBody": "e.g., white toga with purple stripe, leather tunic, silk dress",
      "lowerBody": "e.g., matching toga folds, leather breeches, flowing skirt",
      "footwear": "e.g., leather sandals, riding boots, bare feet",
      "accessories": "e.g., gold ring, leather belt, bronze bracelet, sword",
      "clothingStyle": "e.g., formal senatorial, practical military, worn traveler",
      "clothingColors": "e.g., white and purple, earth tones, rich blues"
    },
    "personality": {
      "demeanor": "e.g., confident, nervous, stern, jovial",
      "traits": "e.g., quick-witted, cautious, ambitious, kind-hearted"
    }
  },
  "timePeriod": "Inherited from story context or determined from text",
  "location": "Inherited from story context or determined from text",
  "photo": "placeholder.png",
  "chapters": [1, 3, 5, 7], // ALL chapters where character appears in any form
  "subCharacteristics": [
    {
      "id": "young_prince",
      "name": "Young Prince Adrian",
      "parameters": {
        "identity": {
          "role": "Crown Prince",
          "age": "16-18",
          "gender": "male"
        },
        "physicalBuild": {
          "height": "5'10\", still growing",
          "build": "slender, youthful",
          "posture": "royal bearing, slightly uncertain"
        },
        "facialFeatures": {
          "skinTone": "fair, unblemished",
          "faceShape": "youthful oval",
          "eyes": "bright blue, innocent",
          "hair": "shoulder-length golden waves",
          "facialHair": "clean-shaven, smooth",
          "distinctiveFeatures": "none yet"
        },
        "attire": {
          "headwear": "simple gold circlet",
          "upperBody": "royal blue velvet doublet with silver embroidery",
          "lowerBody": "matching blue breeches",
          "footwear": "polished leather boots",
          "accessories": "silver chain, royal signet ring",
          "clothingStyle": "formal court attire",
          "clothingColors": "royal blue and silver"
        },
        "personality": {
          "demeanor": "eager but uncertain",
          "traits": "idealistic, learning to rule"
        }
      },
      "timePeriod": "Medieval period, 14th century",
      "location": "Royal castle, Northern Kingdom",
      "chapters": [1, 2, 3],
      "triggerEvent": "Initial appearance",
      "photo": "placeholder.png"
    }
  ]
}

IMPORTANT FORMATTING RULES:
- NEVER use "not specified" or vague terms - provide exhaustive visual details
- Each parameter must be so detailed that an artist could draw it without questions
- Don't just say "military helmet" - describe its exact appearance:
  BAD: "watch captain's helmet"
  GOOD: "bronze bowl-shaped galea with small neck guard, no crest, dented from use"
- Don't use role titles in descriptions, describe the actual visual appearance:
  BAD: "watch insignia"
  GOOD: "small bronze plaque with VII cohort number, worn on leather strap"
- For clothing, describe the exact cut, length, and construction:
  BAD: "dark tunic"
  GOOD: "rough-woven brown wool tunic, knee-length, sleeveless, rope belt"
- Include wear, damage, and realistic details:
  BAD: "military boots"
  GOOD: "worn leather caligae with iron hobnails, straps to mid-calf, left strap repaired"
- Specify exact colors and materials:
  BAD: "dark official colors"
  GOOD: "undyed brown wool with faded edges, leather straps darkened with age"
- For Ancient Rome: describe items as they physically appeared, not their function
- Research actual Roman artifacts and describe those specific items

EXAMPLE FOR ANCIENT ROME (AD 70):
If text only mentions "a night watchman" without description:
BAD PARAMETERS (too vague):
- upperBody: "watch uniform"
- accessories: "watch equipment"
- footwear: "patrol boots"

GOOD PARAMETERS (visual details):
- role: "Member of the seventh cohort of Vigiles"
- skinTone: "weathered Mediterranean olive with soot stains on cheeks"
- hair: "dark brown cut short to skull, slightly singed at edges from fire duty"
- facialHair: "two days of stubble, too tired to shave properly"
- upperBody: "rough undyed brown wool tunic to mid-thigh, torn at right shoulder and crudely mended, sleeveless showing muscled arms with old burn scars"
- lowerBody: "bare thighs above knee with simple linen subligaculum underneath"
- footwear: "worn leather caligae with iron hobnails mostly worn smooth, leather straps wrapped to mid-calf, left strap replaced with rope"
- accessories: "thick leather belt with iron buckle, wooden cudgel (2 feet long, oak, well-used) hanging left, small bronze oil lamp on right, coiled rope"
- clothingStyle: "working man's practical gear, signs of hard use and rough repairs"
- clothingColors: "natural undyed brown wool darkened with soot and grime, leather aged to dark brown"

PROCESSING STEPS:
1. Read the transcript and identify all character mentions
2. For each character, extract specific parameter values from the text
3. For ANY parameter not explicitly mentioned, create detailed visual descriptions:
   - Research actual artifacts and clothing from ${timePeriod} ${location}
   - Describe the physical appearance, not the function or title
   - Include texture, wear patterns, construction details, exact measurements
   - Add realistic imperfections: stains, repairs, wear marks, fading
   - Specify exact shades of color, types of fabric, leather quality
   - Describe items as if you're looking at them, not naming their purpose
4. For existing characters, check if new parameter details are revealed
5. Determine if any character appears in a different state requiring sub-characteristics
6. Add the current chapter (${chapterNumber}) to appropriate chapter arrays
7. VERIFY all parameters are filled with specific visual descriptions
8. ENSURE no modern anachronisms (glasses, watches, modern clothing/uniforms)
9. CRITICAL: When image AI reads your parameters, it should see physical descriptions only
   - "wooden stick about 2 feet long" NOT "authority symbol"
   - "bronze disc with VII etched" NOT "unit insignia"
   - "rough brown wool fabric" NOT "uniform"

RETURN FORMAT:
- Return the COMPLETE updated character database as a JSON array
- Include ALL existing characters plus any new ones found
- Every parameter MUST be filled with specific, descriptive values
- NO "not specified" values allowed - use period-appropriate assumptions
- Double-check for anachronisms:
  * NO eyeglasses in ancient times
  * NO wristwatches or modern accessories
  * NO modern military uniforms (use period armor/uniforms)
  * NO modern hairstyles or clothing
- Ensure ALL parameters match ${timePeriod} in ${location}`;
}

/**
 * Prepares character extraction for CLI processing
 * @param {object} params - Parameters for character extraction
 * @param {string} params.transcript - The chapter transcript
 * @param {string} params.existingCharacters - JSON string of existing characters
 * @param {number} params.chapterNumber - The chapter number
 * @param {string} params.bookPath - Path to the book directory
 * @param {object} params.customPrompts - Custom prompts from settings
 * @param {string} params.tempDir - Temporary directory for prompt file
 * @returns {Promise<object>} Object with promptFile path and other metadata
 */
async function prepareCharacterExtraction({ transcript, existingCharacters, chapterNumber, bookPath, customPrompts, tempDir, contextInfo }) {
    try {
        // Ensure the directory exists
        await fs.mkdir(tempDir, { recursive: true });
        
        // Build the prompt
        const prompt = buildCharacterExtractionPrompt(transcript, existingCharacters, chapterNumber, customPrompts, contextInfo);
        
        // Save the prompt to a temporary file
        const promptFile = path.join(tempDir, `character_extraction_${Date.now()}.txt`);
        await fs.writeFile(promptFile, prompt, 'utf8');
        
        return {
            promptFile: promptFile,
            bookPath: bookPath,
            success: true
        };
    } catch (error) {
        console.error('Error preparing character extraction:', error);
        return {
            error: error.message,
            success: false
        };
    }
}

/**
 * Builds a batch character extraction prompt for multiple chapters
 * @param {Array} chapters - Array of chapter objects with transcript, number, and title
 * @param {string} existingCharacters - JSON string of existing characters
 * @param {object} customPrompts - Custom prompts from settings
 * @returns {string} The complete prompt for batch character extraction
 */
function buildBatchCharacterExtractionPrompt(chapters, existingCharacters, customPrompts, contextInfo = {}) {
    // Extract time period and location from context or use defaults
    const timePeriod = contextInfo.timePeriod || 'Not specified - YOU MUST DETERMINE FROM CONTEXT';
    const location = contextInfo.location || 'Not specified - YOU MUST DETERMINE FROM CONTEXT';
    
    let prompt = `You are an intelligent character database manager for an audiobook with advanced reasoning capabilities. Your task is to analyze MULTIPLE chapter transcripts and maintain a comprehensive character database that tracks physical appearances and their evolution throughout the story.

CRITICAL CONTEXT INFORMATION:
Time Period: ${timePeriod}
Location/Setting: ${location}

These context parameters are ESSENTIAL for accurate character descriptions. If they are not specified, you MUST determine them from the transcripts before describing any characters. The time period and location dramatically affect clothing, hairstyles, accessories, and overall appearance.

Here is the existing character database:
${existingCharacters}

You will now process ${chapters.length} chapters. Analyze ALL chapters before creating the final character database.

`;

    // Add each chapter's transcript
    chapters.forEach(chapter => {
        prompt += `\n=== CHAPTER ${chapter.number}: ${chapter.title} ===\n`;
        prompt += `${chapter.transcript}\n`;
        prompt += `=== END OF CHAPTER ${chapter.number} ===\n`;
    });

    prompt += `
CRITICAL INSTRUCTIONS:

0. **CONTEXT AWARENESS - TIME PERIOD & LOCATION**
   - FIRST, identify or confirm the time period and location from the transcript
   - ALL character descriptions MUST be appropriate for the identified time period and location
   - Example: A senator in Ancient Rome (79 AD) would wear a toga, while a senator in 1970s Washington DC would wear a business suit
   - Clothing, hairstyles, accessories, and social conventions MUST match the time period and location
   - If the time period or location changes within the story, note this in the character's evolution

1. **Character Identification & Aliases**
   ${customPrompts.characterIdentification}

2. **Physical Description Building**
   ${customPrompts.physicalDescription}
   - CRITICAL: All clothing and appearance details MUST be period and location appropriate
   - Research typical dress for the character's social status in that specific time and place

3. **Character Evolution & Sub-Characteristics**
   ${customPrompts.characterEvolution}
   - Track if characters move between locations or time periods
   - Create new sub-characteristics when location/time changes affect appearance
   
4. **Detailed Appearance Descriptions**
   ${customPrompts.descriptionDetail}
   - Ensure all details match the current time period and location
   - Use historically/geographically accurate terminology

5. **Chapter Tracking**
   - For the main character entry: track all chapters where ANY version appears
   - For each sub-characteristic: track specific chapters where that version appears
   - This allows determining which version of a character is active in any given chapter
   - IMPORTANT: Include chapter numbers from ALL the chapters you just analyzed (${chapters.map(c => c.number).join(', ')})

REQUIRED JSON STRUCTURE:
{
  "name": "Character Full Name",
  "parameters": {
    "identity": {
      "role": "e.g., Senator, Knight, Merchant, Scholar",
      "age": "e.g., 45, late 30s, elderly, young adult",
      "gender": "male/female/other"
    },
    "physicalBuild": {
      "height": "e.g., tall 6'2\", average 5'8\", short",
      "build": "e.g., athletic, slender, stocky, heavy-set, muscular",
      "posture": "e.g., upright military bearing, slouched, graceful"
    },
    "facialFeatures": {
      "skinTone": "e.g., olive, pale, dark, sun-weathered",
      "faceShape": "e.g., angular, round, oval, square",
      "eyes": "e.g., deep brown, piercing blue, green with gold flecks",
      "hair": "e.g., short black curls, long golden waves, gray shoulder-length",
      "facialHair": "e.g., full beard, clean-shaven, mustache, stubble",
      "distinctiveFeatures": "e.g., scar above left eye, birthmark on cheek, broken nose"
    },
    "attire": {
      "headwear": "e.g., laurel wreath, hood, crown, nothing",
      "upperBody": "e.g., white toga with purple stripe, leather tunic, silk dress",
      "lowerBody": "e.g., matching toga folds, leather breeches, flowing skirt",
      "footwear": "e.g., leather sandals, riding boots, bare feet",
      "accessories": "e.g., gold ring, leather belt, bronze bracelet, sword",
      "clothingStyle": "e.g., formal senatorial, practical military, worn traveler",
      "clothingColors": "e.g., white and purple, earth tones, rich blues"
    },
    "personality": {
      "demeanor": "e.g., confident, nervous, stern, jovial",
      "traits": "e.g., quick-witted, cautious, ambitious, kind-hearted"
    }
  },
  "timePeriod": "Inherited from story context or determined from text",
  "location": "Inherited from story context or determined from text",
  "photo": "placeholder.png",
  "chapters": [1, 3, 5, 7], // ALL chapters where character appears in any form
  "subCharacteristics": [
    {
      "id": "young_prince",
      "name": "Young Prince Adrian",
      "parameters": {
        "identity": {
          "role": "Crown Prince",
          "age": "16-18",
          "gender": "male"
        },
        "physicalBuild": {
          "height": "5'10\", still growing",
          "build": "slender, youthful",
          "posture": "royal bearing, slightly uncertain"
        },
        "facialFeatures": {
          "skinTone": "fair, unblemished",
          "faceShape": "youthful oval",
          "eyes": "bright blue, innocent",
          "hair": "shoulder-length golden waves",
          "facialHair": "clean-shaven, smooth",
          "distinctiveFeatures": "none yet"
        },
        "attire": {
          "headwear": "simple gold circlet",
          "upperBody": "royal blue velvet doublet with silver embroidery",
          "lowerBody": "matching blue breeches",
          "footwear": "polished leather boots",
          "accessories": "silver chain, royal signet ring",
          "clothingStyle": "formal court attire",
          "clothingColors": "royal blue and silver"
        },
        "personality": {
          "demeanor": "eager but uncertain",
          "traits": "idealistic, learning to rule"
        }
      },
      "timePeriod": "Medieval period, 14th century",
      "location": "Royal castle, Northern Kingdom",
      "chapters": [1, 2, 3],
      "triggerEvent": "Initial appearance",
      "photo": "placeholder.png"
    }
  ]
}

IMPORTANT FORMATTING RULES:
- NEVER use "not specified" or vague terms - provide exhaustive visual details
- Each parameter must be so detailed that an artist could draw it without questions
- Don't just say "military helmet" - describe its exact appearance:
  BAD: "watch captain's helmet"
  GOOD: "bronze bowl-shaped galea with small neck guard, no crest, dented from use"
- Don't use role titles in descriptions, describe the actual visual appearance:
  BAD: "watch insignia"
  GOOD: "small bronze plaque with VII cohort number, worn on leather strap"
- For clothing, describe the exact cut, length, and construction:
  BAD: "dark tunic"
  GOOD: "rough-woven brown wool tunic, knee-length, sleeveless, rope belt"
- Include wear, damage, and realistic details:
  BAD: "military boots"
  GOOD: "worn leather caligae with iron hobnails, straps to mid-calf, left strap repaired"
- Specify exact colors and materials:
  BAD: "dark official colors"
  GOOD: "undyed brown wool with faded edges, leather straps darkened with age"
- For Ancient Rome: describe items as they physically appeared, not their function
- Research actual Roman artifacts and describe those specific items

BATCH PROCESSING STEPS:
1. Read ALL provided chapter transcripts carefully
2. Identify all character mentions across ALL chapters
3. For ANY parameter not explicitly mentioned, create detailed visual descriptions:
   - Research actual artifacts and clothing from ${timePeriod} ${location}
   - Describe the physical appearance, not the function or title
   - Include texture, wear patterns, construction details, exact measurements
   - Add realistic imperfections: stains, repairs, wear marks, fading
   - Specify exact shades of color, types of fabric, leather quality
4. For existing characters, check if new physical details are revealed in any chapter
5. Determine if any character appears in different states requiring sub-characteristics
6. Include ALL chapter numbers (${chapters.map(c => c.number).join(', ')}) in the chapter arrays
7. VERIFY all parameters are filled with specific visual descriptions
8. ENSURE no modern anachronisms (glasses, watches, modern clothing/uniforms)
9. CRITICAL: When image AI reads your parameters, it should see physical descriptions only
   - "wooden stick about 2 feet long" NOT "authority symbol"
   - "bronze disc with VII etched" NOT "unit insignia"
   - "rough brown wool fabric" NOT "uniform"

Return the COMPLETE updated character database as a JSON array. Include ALL existing characters plus any new ones found across ALL the analyzed chapters.`;

    return prompt;
}

/**
 * Prepares batch character extraction for CLI processing
 * @param {object} params - Parameters for batch extraction
 * @param {Array} params.chapters - Array of chapter objects
 * @param {string} params.existingCharacters - JSON string of existing characters
 * @param {string} params.bookPath - Path to the book directory
 * @param {object} params.customPrompts - Custom prompts from settings
 * @param {string} params.tempDir - Temporary directory for prompt file
 * @returns {Promise<object>} Object with promptFile path and other metadata
 */
async function prepareBatchCharacterExtraction({ chapters, existingCharacters, bookPath, customPrompts, tempDir, contextInfo }) {
    try {
        // Ensure the directory exists
        await fs.mkdir(tempDir, { recursive: true });
        
        // Build the batch prompt
        const prompt = buildBatchCharacterExtractionPrompt(chapters, existingCharacters, customPrompts, contextInfo);
        
        // Save the prompt to a temporary file
        const promptFile = path.join(tempDir, `batch_character_extraction_${Date.now()}.txt`);
        await fs.writeFile(promptFile, prompt, 'utf8');
        
        return {
            promptFile: promptFile,
            bookPath: bookPath,
            success: true,
            chapterCount: chapters.length
        };
    } catch (error) {
        console.error('Error preparing batch character extraction:', error);
        return {
            error: error.message,
            success: false
        };
    }
}

/**
 * Builds the CLI command for character extraction
 * @param {string} tool - The CLI tool to use ('claude' or 'gemini')
 * @param {string} promptFile - Path to the prompt file
 * @param {string} outputFile - Path to the output file
 * @returns {object} Command string and options
 */
function buildCLICommand(tool, promptFile, outputFile) {
    let command;
    let commandOptions = {};
    
    if (tool === 'claude') {
        // Use Claude's file reading and structured output
        command = `Read the prompt file at ${promptFile} and extract characters according to the instructions. Save the resulting JSON array to ${outputFile}. Make sure to output valid JSON only without any markdown formatting or code blocks. IMPORTANT: Make sure you're saving to the exact path specified: ${outputFile}`;
        
        commandOptions = {
            nonInteractive: true,
            yolo: true,
            allowedTools: ['Read', 'Write']
        };
    } else if (tool === 'gemini') {
        // Use Gemini's file reading approach
        command = `Read the character extraction prompt from ${promptFile} and analyze it carefully. Extract all characters according to the detailed instructions in the prompt. Save the complete character database as a JSON array to ${outputFile}. Ensure the output is valid JSON format only, without any markdown formatting or code blocks. IMPORTANT: Make sure you're saving to the exact path specified: ${outputFile}`;
        
        commandOptions = {
            nonInteractive: true,
            yolo: true
        };
    } else {
        throw new Error(`Unsupported tool: ${tool}`);
    }
    
    return { command, commandOptions };
}

/**
 * Validates the extracted characters JSON
 * @param {string} filePath - Path to the JSON file
 * @returns {object} Validation result with success flag and data/error
 */
async function validateCharacterOutput(filePath) {
    try {
        const content = await fs.readFile(filePath, 'utf8');
        const characters = JSON.parse(content);
        
        if (!Array.isArray(characters)) {
            return {
                success: false,
                error: 'Output is not an array'
            };
        }
        
        // Basic validation of character structure
        for (const char of characters) {
            if (!char.name || typeof char.name !== 'string') {
                return {
                    success: false,
                    error: 'Invalid character structure: missing or invalid name'
                };
            }
        }
        
        return {
            success: true,
            data: characters,
            count: characters.length
        };
    } catch (error) {
        return {
            success: false,
            error: error.message
        };
    }
}

module.exports = {
    buildCharacterExtractionPrompt,
    prepareCharacterExtraction,
    buildBatchCharacterExtractionPrompt,
    prepareBatchCharacterExtraction,
    buildCLICommand,
    validateCharacterOutput
};