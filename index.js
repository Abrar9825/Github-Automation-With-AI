import express from 'express';
import axios from 'axios';
import chokidar from 'chokidar';
import fs from 'fs';
import path from 'path';
import base64 from 'base64-js';
import { format } from 'date-fns';
import dotenv from 'dotenv'; // Import dotenv
import { GoogleGenerativeAI } from '@google/generative-ai'; // Google AI module
import { minimatch } from 'minimatch'; // Gitignore pattern matching
import { execSync, exec } from 'child_process';

// Load environment variables from .env file
dotenv.config();

// GitHub credentials (from .env file)
const token = process.env.GITHUB_TOKEN; // GitHub token from .env
const username = process.env.GITHUB_USERNAME; // GitHub username from .env

// Initialize Google Generative AI model
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY); // Google API key from .env
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

// Initialize Express app
const app = express();
const port = 3000;

// Middleware to parse URL-encoded data
app.use(express.urlencoded({ extended: true }));

// Serve static files (for HTML)
app.use(express.static('public'));

// Global list to accumulate file changes during the interval
let fileChanges = new Map();

// Function to check if a GitHub repository exists
async function checkRepoExists(repoName) {
    const url = `https://api.github.com/repos/${username}/${repoName}`;
    try {
        const response = await axios.get(url, {
            headers: { Authorization: `Bearer ${token}` },
        });
        return response.status === 200;
    } catch (error) {
        return false;
    }
}

// Function to create a new repository on GitHub
async function createRepo(repoName, isPrivate) {
    const url = 'https://api.github.com/user/repos';
    const data = {
        name: repoName,
        private: isPrivate, // Set repository visibility
    };

    try {
        const response = await axios.post(url, data, {
            headers: { Authorization: `Bearer ${token}` },
        });
        if (response.status === 201) {
            console.log(`Repository '${repoName}' created successfully!`);
        }
    } catch (error) {
        console.error(`Error creating repository: ${error.response.data}`);
        throw new Error('Error creating repository');
    }
}

// Function to handle Git initialization, configuration, and pushing
function setupGitRepo(folderPath, repoName) {
    const gitUrl = `https://${username}:${token}@github.com/${username}/${repoName}.git`;
    // Change this to your GitHub username

    // Safe Git setup
    try {
        if (!fs.existsSync('.git')) {
            execSync("git init");
            execSync("git branch -M main"); // Set 'main' branch
        }

        // Remove & add origin safely
        try {
            execSync("git remote remove origin");
        } catch (err) {
            // Ignore if origin doesn't exist
        }
        execSync(`git remote add origin ${gitUrl}`);

        // Add, commit, and push directly (skip pull)
        execSync("git add .");
        execSync(`git commit -m "Auto-upload from folder" || echo "Nothing to commit"`); // prevent commit error
        execSync("git push -u origin main");  // main branch push

        console.log("✅ Pushed to remote repository.");
    } catch (err) {
        console.error("❌ Git operation failed:", err.message);
    }


}

// Function to push all files from the folder to GitHub initially
async function uploadAllFiles(folderPath, repoName) {
    console.log(`Uploading all files from ${folderPath} to repository ${repoName}...`);
    if (!fs.existsSync(folderPath)) {
        throw new Error(`Directory ${folderPath} does not exist.`);
    }

    // Move to the folder path and setup Git repository
    setupGitRepo(folderPath, repoName);

    console.log(`Finished uploading all files from ${folderPath} to repository ${repoName}.`);
}

// Function to commit a file to the GitHub repository
async function commitFile(repoName, filePath, content, commitMessage, branch = 'main') {
    const gitignorePatterns = readGitignoreFromFolder(path.dirname(filePath)); // Read .gitignore from the folder
    if (isFileIgnored(filePath, gitignorePatterns)) {
        console.log(`Skipping commit for ${filePath} due to .gitignore.`);
        return; // Skip commit for ignored files
    }

    const repoUrl = `https://api.github.com/repos/${username}/${repoName}`;
    const commitUrl = `${repoUrl}/contents/${filePath}`; // Use the relative path

    try {
        let sha = null;
        try {
            const getResponse = await axios.get(commitUrl, {
                headers: { Authorization: `Bearer ${token}` },
            });
            sha = getResponse.data.sha;
        } catch (error) {
            if (error.response && error.response.status === 404) {
                console.log(`File '${filePath}' not found in the repo. Creating new file.`);
            } else {
                throw error;
            }
        }

        const data = {
            message: commitMessage,
            content: base64.fromByteArray(Buffer.from(content)),
            branch: branch,
        };

        if (sha) {
            data.sha = sha;
        }

        const response = await axios.put(commitUrl, data, {
            headers: { Authorization: `Bearer ${token}` },
        });

        if (response.status === 201 || response.status === 200) {
            console.log(`Committed changes to '${filePath}' on GitHub.`);
        } else {
            console.error(`Failed to commit changes to '${filePath}' on GitHub.`);
        }

    } catch (error) {
        console.error(`Error committing changes to ${filePath}:`, error.message);
    }
}

// Function to append content to log.txt file on GitHub
async function appendToLogFile(repoName, content, commitMessage, branch = 'main') {
    const logFilePath = 'log.txt';
    const repoUrl = `https://api.github.com/repos/${username}/${repoName}`;
    const logFileUrl = `${repoUrl}/contents/${logFilePath}`;

    try {
        let sha = null;
        let currentContent = '';
        try {
            const getResponse = await axios.get(logFileUrl, {
                headers: { Authorization: `Bearer ${token}` },
            });
            sha = getResponse.data.sha;
            currentContent = Buffer.from(getResponse.data.content, 'base64').toString();
        } catch (error) {
            if (error.response && error.response.status === 404) {
                console.log('log.txt not found. Creating new log.txt.');
            } else {
                throw error;
            }
        }

        const newLogContent = currentContent + `\n${content}`;
        const data = {
            message: commitMessage,
            content: base64.fromByteArray(Buffer.from(newLogContent)),
            branch: branch,
        };

        if (sha) {
            data.sha = sha;
        }

        const response = await axios.put(logFileUrl, data, {
            headers: { Authorization: `Bearer ${token}` },
        });

        if (response.status === 201 || response.status === 200) {
            console.log('log.txt updated/created on GitHub.');
        }

    } catch (error) {
        console.error('Error updating log.txt:', error.message);
    }
}

// Function to generate summary using Google Generative AI
async function generateSummary(oldContent, newContent) {
    const prompt = `Compare the following old and new code. Provide a clear summary of exactly what changes have been made: what was added, what was removed, and what was modified. Keep the summary short, focusing specifically on the changes.\n\nOld Code:\n${oldContent}\n\nNew Code:\n${newContent}`;

    try {
        const result = await model.generateContent(prompt);
        return result.response.text();
    } catch (error) {
        console.error("Error generating AI summary:", error);
        return "Could not generate AI summary.";
    }
}

// Handle accumulated changes and commit them
async function handleChanges(repoName) {
    if (fileChanges.size > 0) {
        const commitMessage = `Automated commit: Changes detected at ${format(new Date(), 'yyyy-MM-dd HH:mm:ss')}`;
        let logContent = '';
        for (const [filePath, newContent] of fileChanges) {
            let oldContent = '';
            try {
                const getResponse = await axios.get(`https://api.github.com/repos/${username}/${repoName}/contents/${filePath}`, {
                    headers: { Authorization: `Bearer ${token}` },
                });
                oldContent = Buffer.from(getResponse.data.content, 'base64').toString();
            } catch (error) {
                if (error.response && error.response.status === 404) {
                    console.log(`File '${filePath}' not found in the repo. Treating as new file.`);
                } else {
                    throw error;
                }
            }

            // Generate the summary using AI
            const aiSummary = await generateSummary(oldContent, newContent);
            logContent += `File: ${filePath}\nSummary: ${aiSummary}\n\n`;

            // Commit the file to GitHub
            await commitFile(repoName, filePath, newContent, commitMessage);
        }

        // Commit the changes to log.txt on GitHub
        await appendToLogFile(repoName, logContent, commitMessage);

        fileChanges.clear(); // Clear the list after committing
    }
}

// Function to check if a file should be ignored based on .gitignore
function isFileIgnored(filePath, gitignorePatterns) {
    for (const pattern of gitignorePatterns) {
        if (minimatch(filePath, pattern)) {
            return true;
        }
    }
    return false;
}

// Function to read .gitignore patterns from the specified folder
function readGitignoreFromFolder(folderPath) {
    const gitignorePath = path.join(folderPath, '.gitignore');
    if (fs.existsSync(gitignorePath)) {
        return fs.readFileSync(gitignorePath, 'utf8').split('\n').map(pattern => pattern.trim()).filter(Boolean);
    }
    return [];
}

// Handle file change event and ensure we don't push ignored files
function handleFileChange(filePath, folderToMonitor) {
    const relativePath = path.relative(folderToMonitor, filePath);
    console.log(`Detected change in ${relativePath}`);

    const gitignorePatterns = readGitignoreFromFolder(folderToMonitor);
    if (isFileIgnored(relativePath, gitignorePatterns)) {
        console.log(`File ${relativePath} is ignored due to .gitignore.`);
        return; // Skip this file
    }

    if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf8');
        fileChanges.set(relativePath, content);
    } else {
        fileChanges.set(relativePath, "");
    }
}

// Function to start monitoring a folder
function startWatching(repoName, folderToMonitor) {
    const watcher = chokidar.watch(folderToMonitor, { persistent: true, ignoreInitial: true });

    watcher
        .on('add', (filePath) => handleFileChange(filePath, folderToMonitor))
        .on('change', (filePath) => handleFileChange(filePath, folderToMonitor))
        .on('unlink', (filePath) => handleFileChange(filePath, folderToMonitor));

    console.log(`Started monitoring folder: ${folderToMonitor}`);

    // Periodically commit changes every 10 seconds
    setInterval(() => handleChanges(repoName), 10000); // 10 seconds interval
}

// POST route to initiate the monitoring process
app.post('/start', async (req, res) => {
    const { folderToMonitor, repoName, repoAction, repoVisibility, pushAllData } = req.body;

    if (!folderToMonitor || !repoName || !repoAction || !repoVisibility) {
        return res.status(400).send('folderToMonitor, repoName, repoAction, and repoVisibility are required.');
    }

    const isPrivate = repoVisibility === 'private';
    const pushAll = pushAllData === 'true';

    try {
        if (repoAction === 'create') {
            console.log(`Creating repository ${repoName}...`);
            await createRepo(repoName, isPrivate);
        } else {
            const repoExists = await checkRepoExists(repoName);
            if (!repoExists) {
                return res.status(404).send(`Repository ${repoName} does not exist.`);
            }
        }

        // Upload all files to GitHub initially if selected
        if (pushAll) {
            console.log(`Pushing all files from ${folderToMonitor} to repository ${repoName}...`);
            await uploadAllFiles(folderToMonitor, repoName);
            console.log(`All files from ${folderToMonitor} have been pushed to repository ${repoName}.`);
        }

        // Start monitoring the folder for changes
        startWatching(repoName, folderToMonitor);

        res.send(`Started monitoring folder: ${folderToMonitor} and pushing changes to repository: ${repoName}`);
    } catch (error) {
        console.error(error);
        res.status(500).send('Error starting the monitor');
    }
});

// Start the Express server
app.listen(port, () => {
    console.log(`Server started on http://localhost:${port}`);
});