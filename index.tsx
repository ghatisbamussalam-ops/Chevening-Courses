/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import { GoogleGenAI, Type } from "@google/genai";

let ai: GoogleGenAI | null = null;
try {
  ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
} catch (error) {
  console.error("API Key initialization error:", error);
  // ai will remain null, handled below
}


// --- DOM Elements ---
const form = document.getElementById('course-finder-form') as HTMLFormElement;
const submitButton = document.getElementById('submit-button') as HTMLButtonElement;
const inputSection = document.getElementById('input-section') as HTMLElement;
const loadingSection = document.getElementById('loading-section') as HTMLElement;
const loadingMessage = document.getElementById('loading-message') as HTMLParagraphElement;
const resultsSection = document.getElementById('results-section') as HTMLElement;
const errorSection = document.getElementById('error-section') as HTMLElement;
const cvFileInput = document.getElementById('cv-file-input') as HTMLInputElement;
const fileNameDisplay = document.getElementById('file-name-display') as HTMLSpanElement;
const fileUploadLabel = document.querySelector('.file-upload-label') as HTMLLabelElement;
const deadlineCountdown = document.getElementById('deadline-countdown') as HTMLSpanElement;
const pitfallsButton = document.getElementById('pitfalls-button') as HTMLButtonElement;
const pitfallsModal = document.getElementById('pitfalls-modal') as HTMLElement;
const closeModalButton = document.getElementById('close-modal-button') as HTMLButtonElement;


// --- System Prompt and Schema Definition ---
const systemInstruction = `
Role: You analyze a user’s CV and recommend UK master’s courses that are Chevening-eligible, using only the Postgrad/Chevening course index. Then you explain how each choice strengthens a Chevening application (leadership, networking, impact, UK fit), and you produce application-ready talking points.

Hard data constraints:
Search scope: Restrict course discovery to the Chevening-eligible index powered by Postgrad Solutions: the Postgrad Chevening search endpoint (https://www.postgrad.com/search/chevening/) and the official Chevening “Find a course”. Do not invent courses or scrape other sites. If a course isn’t in this index, say so and suggest close in-index substitutes. 
Eligibility rules (must pass all): full-time; UK-based; taught master’s (not MRes); starts autumn (Sep/Oct); 9–12 months duration. Flag MBA fee-cap notes. Reject anything outside these rules. 

Pipeline:
1. Parse CV → strengths & gaps relevant to Chevening criteria (leadership, networking, clear country impact, academic readiness, UK/sector linkage).
2. Query Postgrad/Chevening index with the user’s target fields and UK locations.
3. Eligibility filter using the rules above; drop non-conforming items. For each recommended course, explicitly return an eligibility check object. If it fails, state why.
4. Scoring (0–30): Gap fit vs CV (×3), Chevening relevance (×3), UK linkage/credibility (×2), Feasibility (×2), Portfolio/outcomes (×1), Networking exposure (×1).
5. For each course, provide a short, expandable note explaining the rank, referencing the scoring criteria (e.g., "Ranked #1 due to strong alignment with your CV's leadership experience (gap-fit) and direct relevance to your country-impact goal (Chevening relevance).").
6. Return a ranked Top-9 with Chevening-specific rationales + 3 close alternates, a 3-course strategy (the trio you’d actually list on the form), and brief talking points for each essay section.
7. Truthfulness: If fees/start cycles are unclear in the index, mark them “Verify on university site.” No guesses.
8. MBA Alert: If a programme is an MBA, include a note in the Chevening rationale about the £22,000 fee cap.

Tone: crisp, factual, zero fluff. No marketing language.
`;

const responseSchema = {
  type: Type.OBJECT,
  properties: {
    profile: {
      type: Type.OBJECT,
      description: "Analysis of the user's CV against Chevening criteria.",
      properties: {
        strengths: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Key strengths from the CV." },
        gaps: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Areas for development or focus." },
      }
    },
    ranked_courses: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          rank: { type: Type.INTEGER },
          university: { type: Type.STRING },
          programme: { type: Type.STRING },
          city: { type: Type.STRING },
          url: { type: Type.STRING },
          start_cycle: { type: Type.STRING },
          duration_months: { type: Type.INTEGER },
          fee_gbp: { type: Type.STRING },
          chevening_rationale: { type: Type.ARRAY, items: { type: Type.STRING } },
          eligibility_check: {
            type: Type.OBJECT,
            description: "A check against key Chevening eligibility criteria.",
            properties: {
              is_eligible: { type: Type.BOOLEAN },
              reason: { type: Type.STRING, description: "Reason for eligibility status, e.g., 'Passes all checks' or 'Ineligible: duration is over 12 months'."}
            }
          },
          score_breakdown: {
            type: Type.STRING,
            description: "A short explanation of why the course received its rank, based on scoring criteria."
          }
        }
      }
    },
    chevening_trio: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          university: { type: Type.STRING },
          programme: { type: Type.STRING },
          why_this_trio: { type: Type.STRING }
        }
      }
    },
    personal_statement_bullets: {
      type: Type.OBJECT,
      properties: {
        leadership: { type: Type.ARRAY, items: { type: Type.STRING } },
        networking: { type: Type.ARRAY, items: { type: Type.STRING } },
        career_plan: { type: Type.ARRAY, items: { type: Type.STRING } }
      }
    },
    alternatives: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          university: { type: Type.STRING },
          programme: { type: Type.STRING },
          url: { type: Type.STRING },
          why_consider: { type: Type.STRING }
        }
      }
    },
    notes: { type: Type.ARRAY, items: { type: Type.STRING } }
  }
};


// --- App Logic ---
const loadingMessages = [
    "Analyzing your CV against Chevening criteria...",
    "Searching the official course database...",
    "Scoring and ranking top matches...",
    "Compiling your personalized strategy...",
    "This may take a moment. Great recommendations are on their way!"
];
let messageInterval: ReturnType<typeof setInterval>;
let countdownInterval: ReturnType<typeof setInterval>;

// --- Deadline Countdown ---
function setDeadline() {
    // Deadline: 7 October 2025 at 12:00 UTC
    const deadline = new Date('2025-10-07T12:00:00Z');

    function updateCountdown() {
        const now = new Date();
        const diff = deadline.getTime() - now.getTime();

        if (diff <= 0) {
            deadlineCountdown.textContent = "The deadline has passed.";
            if(countdownInterval) clearInterval(countdownInterval);
            return;
        }

        const days = Math.floor(diff / (1000 * 60 * 60 * 24));
        const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((diff % (1000 * 60)) / 1000);

        deadlineCountdown.textContent = `${days}d ${hours}h ${minutes}m ${seconds}s`;
    }
    
    if (countdownInterval) clearInterval(countdownInterval);
    countdownInterval = setInterval(updateCountdown, 1000);
    updateCountdown(); // Initial call
}

// Helper to convert a File object to a GoogleGenerativeAI.Part object.
async function fileToGenerativePart(file: File) {
    const base64EncodedDataPromise = new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            const dataUrl = reader.result as string;
            const base64Data = dataUrl.split(',')[1];
            resolve(base64Data);
        };
        reader.readAsDataURL(file);
    });
    return {
        inlineData: {
            data: await base64EncodedDataPromise,
            mimeType: file.type
        },
    };
}


function showLoading(show: boolean) {
    if (show) {
        inputSection.classList.add('hidden');
        resultsSection.innerHTML = '';
        errorSection.classList.add('hidden');
        loadingSection.classList.remove('hidden');
        submitButton.disabled = true;

        let messageIndex = 0;
        loadingMessage.textContent = loadingMessages[messageIndex];
        messageInterval = setInterval(() => {
            messageIndex = (messageIndex + 1) % loadingMessages.length;
            loadingMessage.textContent = loadingMessages[messageIndex];
        }, 3000);

    } else {
        loadingSection.classList.add('hidden');
        inputSection.classList.remove('hidden');
        submitButton.disabled = false;
        clearInterval(messageInterval);
    }
}

function showError(message: string) {
    resultsSection.innerHTML = '';
    errorSection.innerHTML = `<p><strong>An error occurred:</strong> ${message}</p><p>Please try again.</p>`;
    errorSection.classList.remove('hidden');
}


function renderResults(data: any) {
    resultsSection.innerHTML = ''; // Clear previous results

    if (data.profile) {
        resultsSection.innerHTML += renderProfileAnalysis(data.profile);
    }
    if (data.chevening_trio) {
        resultsSection.innerHTML += renderTrio(data.chevening_trio);
    }
    if (data.ranked_courses) {
        resultsSection.innerHTML += renderRankedCourses(data.ranked_courses);
    }
    if (data.personal_statement_bullets) {
        resultsSection.innerHTML += renderBullets(data.personal_statement_bullets);
    }
    if (data.alternatives) {
        resultsSection.innerHTML += renderAlternatives(data.alternatives);
    }
     if (data.notes) {
        resultsSection.innerHTML += renderNotes(data.notes);
    }
}

function renderProfileAnalysis(profile: any) {
    if (!profile.strengths || !profile.gaps) return '';
    return `
      <div id="profile-analysis-section" class="result-category">
        <h2>CV Analysis vs. Chevening Criteria</h2>
        <div class="profile-columns">
            <div class="profile-column">
                <h3>Strengths</h3>
                <ul>${profile.strengths.map((s: string) => `<li>${s}</li>`).join('')}</ul>
            </div>
            <div class="profile-column">
                <h3>Potential Gaps</h3>
                <ul>${profile.gaps.map((g: string) => `<li>${g}</li>`).join('')}</ul>
            </div>
        </div>
      </div>
    `;
}

function renderTrio(trio: any[]) {
    const universities = new Set(trio.map(course => course.university));
    const singleUniversityWarning = universities.size === 1 && trio.length > 1 ?
        `<p class="trio-warning"><strong>Note:</strong> All three choices are from the same university. This is permitted, but Chevening often recommends diversifying your choices to spread risk.</p>` : '';

    return `
      <div class="result-category">
        <h2>Your Recommended Chevening Trio</h2>
        ${singleUniversityWarning}
        ${trio.map(course => {
          const isMBA = course.programme.toLowerCase().includes('mba');
          const mbaWarning = isMBA ? `<p class="mba-warning"><strong>MBA Fee Cap:</strong> Chevening caps MBA tuition at £22,000. You must fund any difference.</p>` : '';
          return `
            <div class="trio-card">
              <h3>${course.programme}</h3>
              <p class="university">${course.university}</p>
              <p>${course.why_this_trio}</p>
              ${mbaWarning}
            </div>
          `
        }).join('')}
      </div>
    `;
}

function renderRankedCourses(courses: any[]) {
    return `
      <div class="result-category">
        <h2>Top Ranked Courses</h2>
        ${courses.map(course => {
          const { eligibility_check, score_breakdown, programme, fee_gbp } = course;
          
          const eligibilityBadge = eligibility_check ? 
              (eligibility_check.is_eligible ? 
                  `<span class="eligibility-badge">Chevening-eligible ✅</span>` : 
                  `<span class="eligibility-badge ineligible">Ineligible ❌</span>`
              ) : '';
          const eligibilityReason = eligibility_check && !eligibility_check.is_eligible ? `<p class="ineligible-reason">${eligibility_check.reason}</p>` : '';
          const isMBA = programme.toLowerCase().includes('mba');
          const mbaWarning = isMBA ? `<p class="mba-warning"><strong>MBA Fee Cap:</strong> Chevening caps MBA tuition at £22,000. You must fund any difference.</p>` : '';
      
          const feeDisplay = fee_gbp && fee_gbp.toLowerCase().includes('verify') ? `<span class="verify-chip">${fee_gbp}</span>` : `💷 ${fee_gbp || 'N/A'}`;

          return `
            <div class="course-card">
              <h3>${course.rank}. ${course.programme}</h3>
              <p class="university">${course.university}</p>
              ${eligibilityBadge}
              ${eligibilityReason}
              ${mbaWarning}
              <div class="details">
                <span>📍 ${course.city}</span>
                <span>🗓️ ${course.start_cycle}</span>
                <span>⏳ ${course.duration_months} months</span>
                <span>${feeDisplay}</span>
              </div>
              ${score_breakdown ? `
              <details class="score-breakdown">
                  <summary>Why this rank?</summary>
                  <p>${score_breakdown}</p>
              </details>
              ` : ''}
              <div class="chevening-rationale">
                <strong>Chevening Rationale:</strong>
                <ul>
                  ${course.chevening_rationale.map((r: string) => `<li>${r}</li>`).join('')}
                </ul>
              </div>
              <p><a href="${course.url}" target="_blank" rel="noopener noreferrer">Visit course page →</a></p>
            </div>
          `
        }).join('')}
      </div>
    `;
}

function renderBullets(bullets: any) {
    return `
        <div class="result-category personal-statement-bullets">
            <h2>Personal Statement Talking Points</h2>
            <h4>Leadership</h4>
            <ul>${bullets.leadership.map((b: string) => `<li>${b}</li>`).join('')}</ul>
            <h4>Networking</h4>
            <ul>${bullets.networking.map((b: string) => `<li>${b}</li>`).join('')}</ul>
            <h4>Career Plan</h4>
            <ul>${bullets.career_plan.map((b: string) => `<li>${b}</li>`).join('')}</ul>
        </div>
    `;
}

function renderAlternatives(alternatives: any[]) {
    return `
      <div class="result-category">
        <h2>Alternative Options</h2>
        ${alternatives.map(alt => `
          <div class="course-card">
             <h3>${alt.programme}</h3>
             <p class="university">${alt.university}</p>
             <p>${alt.why_consider}</p>
             <p><a href="${alt.url}" target="_blank" rel="noopener noreferrer">Visit course page →</a></p>
          </div>
        }).join('')}
      </div>
    `;
}
function renderNotes(notes: string[]) {
    return `
        <div class="result-category">
            <h2>Important Notes</h2>
            <ul>
                ${notes.map(note => `<li>${note}</li>`).join('')}
            </ul>
        </div>
    `;
}

// --- App Start ---

// Set deadline countdown regardless of API key status
setDeadline();

// Modal logic doesn't depend on the API, but its trigger button does.
// We set up listeners for elements outside the form.
closeModalButton.addEventListener('click', () => {
    pitfallsModal.classList.add('hidden');
});
pitfallsModal.addEventListener('click', (e) => {
    // Close if clicking on the overlay itself
    if (e.target === pitfallsModal) {
        pitfallsModal.classList.add('hidden');
    }
});


if (ai) {
    // --- API is available, set up the form listeners ---

    pitfallsButton.addEventListener('click', () => {
        pitfallsModal.classList.remove('hidden');
    });

    // Add event listener for file input to display the selected file name
    cvFileInput.addEventListener('change', () => {
        if (cvFileInput.files && cvFileInput.files.length > 0) {
            const fileName = cvFileInput.files[0].name;
            fileNameDisplay.textContent = `Selected: ${fileName}`;
            fileUploadLabel.textContent = 'Change file';
        } else {
            fileNameDisplay.textContent = '';
            fileUploadLabel.textContent = 'Click to select a file';
        }
    });

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const cvFile = cvFileInput.files?.[0];
        if (!cvFile) {
            showError("Please upload your CV file.");
            return;
        }
        
        const allowedTypes = ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
        if (!allowedTypes.includes(cvFile.type)) {
            showError("Invalid file type. Please upload a PDF or DOCX file.");
            return;
        }
        
        showLoading(true);

        const fields = (document.getElementById('fields-input') as HTMLInputElement).value;
        const locations = (document.getElementById('locations-input') as HTMLInputElement).value;
        const impact = (document.getElementById('impact-input') as HTMLInputElement).value;
        const year = (document.getElementById('year-input') as HTMLInputElement).value;

        const userPromptText = `
          Task: Pick Chevening-eligible UK master’s courses that best match my CV and career plan. The CV is provided in the attached file.
          
          Inputs:
          Target fields: "${fields}"
          Preferred UK locations: "${locations}"
          Timeline: must start Sep/Oct ${year}
          Country-impact one-liner: "${impact}"
    
          Return JSON output per the required schema. Analyze the CV file to extract the candidate's profile, skills, and experience to inform the course matching.
        `;

        try {
            const filePart = await fileToGenerativePart(cvFile);
            const textPart = { text: userPromptText };

            const response = await ai.models.generateContent({
                model: "gemini-2.5-flash",
                contents: { parts: [filePart, textPart] },
                config: {
                    systemInstruction: systemInstruction,
                    responseMimeType: "application/json",
                    responseSchema: responseSchema,
                },
            });

            const jsonText = response.text.trim();
            const data = JSON.parse(jsonText);
            renderResults(data);

        } catch (error)
         {
            console.error(error);
            showError(error instanceof Error ? error.message : "Could not process the file or parse the response from the model.");
        } finally {
            showLoading(false);
            setTimeout(() => resultsSection.scrollIntoView({ behavior: 'smooth' }), 100);
        }
    });

} else {
    // --- API is NOT available. Show an error message. ---
    
    inputSection.innerHTML = `
      <div id="config-error" role="alert">
        <p><strong>Application Configuration Error</strong></p>
        <p>This application is not properly configured to connect to the AI service because an API key has not been provided. If you are a user, please contact the person who shared this with you. If you are the developer, please ensure the API key is correctly set up in your environment.</p>
      </div>
    `;
    const style = document.createElement('style');
    style.textContent = `
      #config-error {
        background-color: #FFCDD2;
        color: #D32F2F;
        border-radius: var(--border-radius);
        padding: 1.5rem;
        text-align: center;
      }
      #config-error p { margin-bottom: 0.5rem; }
    `;
    document.head.appendChild(style);
}
