#!/usr/bin/env node
import { spawn } from 'child_process';
import { config } from 'dotenv';

config();

const MCP_SERVER_PATH = './dist/index.js';

class FixedWorkspaceCreator {
  constructor() {
    this.server = null;
  }

  async startServer() {
    return new Promise((resolve, reject) => {
      this.server = spawn('node', [MCP_SERVER_PATH], {
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe']
      });

      this.server.on('error', reject);
      
      // Capture stderr for debugging
      this.server.stderr.on('data', (data) => {
        console.error('Server:', data.toString());
      });
      
      setTimeout(resolve, 2000);
    });
  }

  async sendRequest(method, params = {}) {
    return new Promise((resolve) => {
      const request = {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
          name: method,
          arguments: params
        },
        id: Date.now()
      };

      this.server.stdin.write(JSON.stringify(request) + '\n');

      const handler = (data) => {
        const lines = data.toString().split('\n').filter(line => line.trim());
        for (const line of lines) {
          try {
            const response = JSON.parse(line);
            if (response.id === request.id) {
              this.server.stdout.removeListener('data', handler);
              resolve(response);
            }
          } catch (e) {
            // Continue
          }
        }
      };

      this.server.stdout.on('data', handler);
      
      setTimeout(() => {
        this.server.stdout.removeListener('data', handler);
        resolve({ error: { message: 'Timeout' } });
      }, 15000);
    });
  }

  async createFixedWorkspace() {
    console.log('🚀 Creating FIXED Workspace with Initial Document');
    console.log('='.repeat(60));
    
    await this.startServer();
    console.log('✅ MCP Server started\n');
    
    // Use the new fixed tool
    console.log('📁 Creating workspace with initial document...');
    const wsResult = await this.sendRequest('affine_create_workspace_fixed', {
      name: 'AFFiNE MCP v1.1.0 Working',
      avatar: '🚀'
    });
    
    if (wsResult.error) {
      console.error('❌ Failed to create workspace:', wsResult.error.message);
      this.server.kill();
      return;
    }
    
    const wsData = JSON.parse(wsResult.result.content[0].text);
    
    console.log(`✅ Status: ${wsData.status}`);
    
    if (wsData.id) {
      console.log(`📌 Workspace ID: ${wsData.id}`);
      console.log(`📄 Initial Document ID: ${wsData.firstDocId}`);
      console.log(`🔗 View at: ${wsData.url || process.env.AFFINE_BASE_URL + '/workspace/' + wsData.id}`);
      
      if (wsData.message) {
        console.log(`💬 ${wsData.message}`);
      }
    } else if (wsData.error) {
      console.error(`❌ Error: ${wsData.error}`);
      if (wsData.note) {
        console.error(`📝 Note: ${wsData.note}`);
      }
    }
    
    console.log('\n' + '='.repeat(60));
    console.log('Test complete. Check the AFFiNE UI to verify the workspace is accessible.');
    console.log('='.repeat(60));
    
    if (this.server) {
      this.server.kill();
    }
  }
}

const creator = new FixedWorkspaceCreator();
creator.createFixedWorkspace().catch(console.error);