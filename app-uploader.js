#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';

import Argv from './modules/app-argv.js';
import TeraBoxApp from './modules/api.js';
import { filesize } from 'filesize';

import {
    loadJson, saveJson,
    selectAccount, showAccountInfo,
    selectLocalDir, selectRemoteDir,
    scanLocalDir, uploadChunks, uploadFile,
    hashFile, getChunkSize,
    unwrapErrorMessage,
} from './modules/app-helper.js';

// init app
let app = {};
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = loadJson(path.resolve(__dirname, './.config.json'));
const meta = loadJson(path.resolve(__dirname, './package.json'));

console.log('[INFO] TeraBox App', 'v' + meta.version, '(Uploader Module)');

const yargs = new Argv(config, ['a','l','r']);
if(yargs.getArgv('help')){
    yargs.showHelp();
    process.exit();
}

(async () => {
    if(!config.accounts){
        console.error('[ERROR] Accounts not set!');
        return;
    }

    let cur_acc;
    if(yargs.getArgv('a')){
        cur_acc = config.accounts[yargs.getArgv('a')];
    }
    else{
        cur_acc = await selectAccount(config);
    }
    
    app = new TeraBoxApp(cur_acc);
    
    const acc_check = await app.checkLogin();
    if(acc_check.errno != 0){
        console.error('[ERROR] "ndus" cookie is BAD!');
        return;
    }
    
    await showAccountInfo(app);
    await selectDirs();
})();

async function selectDirs(){
    const localDir = await selectLocalDir(yargs.getArgv('l'));
    const remoteDir = await selectRemoteDir(yargs.getArgv('r'));
    
    await uploadDir(localDir, remoteDir);
    console.log('\n:: Done!\n');
}

async function uploadDir(localDir, remoteDir){
    const fsList = scanLocalDir(localDir);
    
    let remoteFsList = [];
    try {
        const reqRemoteDir = await app.getRemoteDir(remoteDir);
        if(reqRemoteDir.errno == 0){
            remoteFsList = reqRemoteDir.list;
        }
        else{
            await app.updateAppData();
            const remoteDirData = await app.createFolder(remoteDir);
            if(remoteDirData.errno != 0){
                const error = new Error('Bad Response');
                error.data = remoteDirData;
                throw error;
            }
        }
    }
    catch(error){
        console.error('[ERROR] Failed to fetch remote dir:', remoteDir);
        console.error(error);
        return;
    }
    
    console.log('\n? Local Dir:', localDir);
    console.log('? Remote Dir:', remoteDir);
    const fsListFiles = fsList.filter(item => !item.is_dir);
    
    for(const fi of fsList){
        if(fi.is_dir){
            fi.path = fi.path.replace(/\/$/, '');
            const remoteDirNew = remoteDir + '/' + fi.path.split('/').at(-1);
            await uploadDir(fi.path, remoteDirNew);
            continue;
        }
        
        const filePath = fi.path;
        const isTBHash = filePath.match(/\.tbhash$/) ? true : false;
        
        const tbtempfile = isTBHash ? filePath : filePath + '.tbtemp';
        const data = loadJson(tbtempfile);
        delete data.error;
        
        if(!data.upload_id || typeof(data.upload_id) != 'string'){
            data.upload_id = '';
        }
        if(!data.remote_dir || typeof(data.remote_dir) != 'string'){
            data.remote_dir = remoteDir;
        }
        if(!data.file || typeof(data.file) != 'string'){
            data.file = path.basename(filePath);
            if(isTBHash){
                data.file = data.file.replace(/\.tbhash$/,'');
            }
        }
        if(!isTBHash && (!data.size || isNaN(data.size))){
            data.size = fs.statSync(filePath).size;
        }
        
        const index = fsListFiles.indexOf(fi) + 1;
        const indexStr = `${index}/${fsListFiles.length}`;
        const filesizeStr = filesize(parseInt(data.size), {standard: 'iec', round: 3, pad: true});
        
        console.log(`\n:: Processing: [${indexStr}] ${data.file} (${filesizeStr})`);
        
        if(data.size < 1){
            console.log(`:: Empty file, skipping...`);
            continue;
        }
        
        if(data.size > getChunkSize(data.size, app.params.is_vip) * 1024){
            console.log(`:: File too big, skipping...`);
            continue;
        }
        
        const findRemote = remoteFsList.find(f => {
            return f.server_filename == data.file;
        });
        
        const dontComparedRemote = remoteFsList.find(f => {
            return f.server_filename == data.file && f.size != data.size;
        });
        
        
        if(findRemote){
            console.log(`:: On Remote server Folder or File exist with same name, skipping...`);
            if(dontComparedRemote){
                const localFileSize = filesize(data.size, {standard: 'iec', round: 3, pad: true});
                const remoteFileSize = filesize(dontComparedRemote.size, {standard: 'iec', round: 3, pad: true});
                console.warn(':: But file size not match: LOCAL/REMOTE', localFileSize, '/', remoteFileSize);
            }
            continue;
        }
        
        if(!isTBHash && !data.hash){
            console.log(':: Calculating hashes...');
            data.hash = await hashFile(filePath);
            saveJson(tbtempfile, data);
        }
        
        if(data.size > 256 * 1024){
            try {
                console.log(`:: Trying RapidUpload file...`);
                await app.updateAppData();
                // do rapid upload...
                const rapidUploadData = await app.rapidUpload(data);
                if(rapidUploadData.errno == 0){
                    const remoteFile = rapidUploadData.info.path.split('/').at(-1);
                    const remoteFileSize = filesize(parseInt(rapidUploadData.info.size), {standard: 'iec', round: 3, pad: true});
                    console.log(`:: Uploaded:`, remoteFile, `(${remoteFileSize})`);
                    remoteFsList.push({ server_filename: remoteFile });
                    if(!isTBHash){
                        removeTbTemp(tbtempfile);
                    }
                    continue;
                }
                else{
                    console.warn(':: Failed to RapidUpload file:', rapidUploadData);
                }
                if(rapidUploadData.errno == 413){
                    console.warn(':: To use this feature you need accept one of');
                    console.warn('   referral program at https://www.terabox.com/webmaster');
                }
            }
            catch(error){
                console.error(':: Failed to RapidUpload file:', error);
            }
        }
        
        if(isTBHash){
            continue;
        }
        
        console.log(`:: Precreate file...`);
        await app.updateAppData();
        
        try{
            const preCreateData = await app.precreateFile(data);
            if(preCreateData.errno == 0){
                // save new upload id
                data.upload_id = preCreateData.uploadid;
                saveJson(tbtempfile, data);
                // fill uploaded data temporary
                data.uploaded = new Array(data.hash.chunks.length).fill(true);
                for(const uBlock of preCreateData.block_list){
                    data.uploaded[uBlock] = false;
                }
            }
            else{
                const error = new Error('Bad Response');
                error.data = remoteDirData;
                throw error;
            }
        }
        catch(error){
            console.error('[ERROR] Can\'t precreate file:', error);
            continue;
        }
        
        let upload_status;
        if(data.size <= getChunkSize(data.size)){
            console.log(`:: Upload file...`);
            upload_status = await uploadFile(app, data, filePath);
        }
        else{
            console.log(`:: Upload chunks...`);
            upload_status = await uploadChunks(app, data, filePath);
        }
        console.log(); // reset stdout after process.write
        delete data.uploaded;
        
        if(upload_status){
            try{
                console.log(`:: Create file...`);
                await app.updateAppData();
                const upload_info = await app.createFile(data);
                
                if(upload_info.errno == 0){
                    const remoteFile = upload_info.name.split('/').at(-1);
                    const remoteFileSize = filesize(parseInt(upload_info.size), {standard: 'iec', round: 3, pad: true});
                    console.log(`:: Uploaded:`, remoteFile, `(${remoteFileSize})`);
                    remoteFsList.push({ server_filename: remoteFile });
                    if(data.size != parseInt(upload_info.size)){
                        console.error(':: ERROR: File sizes not match!');
                        continue;
                    }
                    removeTbTemp(tbtempfile);
                    continue;
                }
                const error = new Error('Bad Response');
                error.data = upload_info;
                throw error;
            }
            catch(error){
                console.error('[ERROR] Can\'t save file to remote:', unwrapErrorMessage(error));
            }
        }
    }
}

function removeTbTemp(tbtempfile){
    try{
        fs.unlinkSync(tbtempfile);
    }
    catch(error){
        console.error('[ERROR] Can\'t remove tbtemp file:', unwrapErrorMessage(error));
    }
}
