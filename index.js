// Required Modules
import express from 'express';
import axios from 'axios';
import chokidar from 'chokidar';
import fs from 'fs';
import path, { dirname } from 'path';
import base64 from 'base64-js';
import { format } from 'date-fns';
import dotenv from 'dotenv';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { minimatch } from 'minimatch';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

// ES Module __dirname workaround
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env configuration
dotenv.config();

// GitHub Credentials
const token = process.env.GITHUB_TOKEN;
const username = process.env.GITHUB_USERNAME;

// Google AI Setup
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

// Express App Setup
const app = express();
const port = 3000;
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// In-memory tracking of file changes
let fileChanges = new Map();

// Check if repository exists
async function checkRepoExists(repoName) {
    try {
        const res = await axios.get(`https://api.github.com/repos/${username}/${repoName}`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        return res.status === 200;
    } catch {
        return false;
    }
}

// Create GitHub repo
async function createRepo(repoName, isPrivate) {
    const data = { name: repoName, private: isPrivate };
    await axios.post('https://api.github.com/user/repos', data, {
        headers: { Authorization: `Bearer ${token}` },
    });
}

// Setup Git, commit, and push all
function setupGitRepo(folderPath, repoName) {
    const gitUrl = `https://${username}:${token}@github.com/${username}/${repoName}.git`;
    process.chdir(folderPath);

    if (!fs.existsSync('.git')) {
        execSync('git init');
        execSync('git branch -M main');
    }

    try { execSync('git remote remove origin'); } catch { }
    execSync(`git remote add origin ${gitUrl}`);
    execSync('git add .');
    execSync(`git commit -m "Auto-upload from folder" || echo "Nothing to commit"`);
    execSync('git push -u origin main');

    console.log("✅ Initial push done.");
    process.chdir(__dirname);
}

// Push all files
async function uploadAllFiles(folderPath, repoName) {
    if (!fs.existsSync(folderPath)) throw new Error("Folder not found");
    setupGitRepo(folderPath, repoName);
}

// Commit single file
async function commitFile(repoName, filePath, content, commitMessage, branch = 'main') {
    const commitUrl = `https://api.github.com/repos/${username}/${repoName}/contents/${filePath}`;
    const gitignorePatterns = readGitignoreFromFolder(path.dirname(filePath));
    if (isFileIgnored(filePath, gitignorePatterns)) return;

    let sha = null;
    try {
        const res = await axios.get(commitUrl, {
            headers: { Authorization: `Bearer ${token}` },
        });
        sha = res.data.sha;
    } catch { }

    const data = {
        message: commitMessage,
        content: base64.fromByteArray(Buffer.from(content)),
        branch,
    };
    if (sha) data.sha = sha;

    await axios.put(commitUrl, data, {
        headers: { Authorization: `Bearer ${token}` },
    });
    console.log(`✅ ${filePath} committed.`);
}

// Append to log.txt on GitHub
async function appendToLogFile(repoName, content, commitMessage) {
    const filePath = 'log.txt';
    const url = `https://api.github.com/repos/${username}/${repoName}/contents/${filePath}`;

    let currentContent = '';
    let sha = null;

    try {
        const res = await axios.get(url, {
            headers: { Authorization: `Bearer ${token}` },
        });
        currentContent = Buffer.from(res.data.content, 'base64').toString();
        sha = res.data.sha;
    } catch { }

    const data = {
        message: commitMessage,
        content: base64.fromByteArray(Buffer.from(currentContent + `\n${content}`)),
        branch: 'main',
    };
    if (sha) data.sha = sha;

    await axios.put(url, data, {
        headers: { Authorization: `Bearer ${token}` },
    });
    console.log("📘 log.txt updated.");
}

// Generate AI Summary
async function generateSummary(oldContent, newContent) {
    const prompt = `Compare the following code changes:\n\nOld:\n${oldContent}\n\nNew:\n${newContent}\n\nGive a short summary of what was changed.`;
    try {
        const res = await model.generateContent(prompt);
        return res.response.text();
    } catch (e) {
        console.error("AI Summary Error:", e.message);
        return "Could not generate summary.";
    }
}

// Periodic Commit Handler
async function handleChanges(repoName) {
    if (fileChanges.size === 0) return;

    const commitMessage = `Automated commit: ${format(new Date(), 'yyyy-MM-dd HH:mm:ss')}`;
    let logData = '';

    for (const [filePath, newContent] of fileChanges) {
        let oldContent = '';
        try {
            const res = await axios.get(`https://api.github.com/repos/${username}/${repoName}/contents/${filePath}`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            oldContent = Buffer.from(res.data.content, 'base64').toString();
        } catch { }

        const summary = await generateSummary(oldContent, newContent);
        logData += `🗂 File: ${filePath}\n📝 Summary: ${summary}\n\n`;

        await commitFile(repoName, filePath, newContent, commitMessage);
    }

    await appendToLogFile(repoName, logData, commitMessage);
    fileChanges.clear();
}

// Gitignore logic
function isFileIgnored(filePath, patterns) {
    return patterns.some(pattern => minimatch(filePath, pattern));
}

function readGitignoreFromFolder(folder) {
    const gitignore = path.join(folder, '.gitignore');
    if (!fs.existsSync(gitignore)) return [];
    return fs.readFileSync(gitignore, 'utf8').split('\n').map(p => p.trim()).filter(Boolean);
}

// On file add/change/delete
function handleFileChange(filePath, rootPath) {
    const relativePath = path.relative(rootPath, filePath);
    const ignorePatterns = readGitignoreFromFolder(rootPath);
    if (isFileIgnored(relativePath, ignorePatterns)) return;

    const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
    fileChanges.set(relativePath, content);
    console.log(`📁 Change detected: ${relativePath}`);
}

// Watch folder
function startWatching(repoName, folderPath) {
    chokidar.watch(folderPath, { persistent: true, ignoreInitial: true })
        .on('add', file => handleFileChange(file, folderPath))
        .on('change', file => handleFileChange(file, folderPath))
        .on('unlink', file => handleFileChange(file, folderPath));

    console.log(`👀 Monitoring: ${folderPath}`);

    setInterval(() => handleChanges(repoName), 10000); // Every 10 sec
}

// POST endpoint to start process
app.post('/start', async (req, res) => {
    const { folderToMonitor, repoName, repoAction, repoVisibility, pushAllData } = req.body;

    if (!folderToMonitor || !repoName || !repoAction || !repoVisibility) {
        return res.status(400).send("Missing parameters.");
    }

    try {
        if (repoAction === 'create') {
            await createRepo(repoName, repoVisibility === 'private');
        } else {
            const exists = await checkRepoExists(repoName);
            if (!exists) return res.status(404).send("Repo not found.");
        }

        if (pushAllData === 'true') {
            await uploadAllFiles(folderToMonitor, repoName);
        }

        startWatching(repoName, folderToMonitor);
        res.send(`📦 Monitoring ${folderToMonitor} and syncing with ${repoName}`);
    } catch (e) {
        console.error("Error:", e.message);
        res.status(500).send("Something went wrong.");
    }
});

// Start server
app.listen(port, () => {
    console.log(`🚀 Server running: http://localhost:${port}`);
});
