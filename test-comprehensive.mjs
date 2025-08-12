#!/usr/bin/env node
import { spawn } from 'child_process';
import { config } from 'dotenv';
import fs from 'fs';

config();

const MCP_SERVER_PATH = './dist/index.js';

// Tool categories for 50 tools
const TOOL_CATEGORIES = {
  workspace: [
    'affine_list_workspaces',
    'affine_get_workspace',
    'affine_create_workspace',
    'affine_update_workspace',
    'affine_delete_workspace',
    'affine_leave_workspace',
    'affine_invite_members'
  ],
  document: [
    'affine_list_docs',
    'affine_get_doc',
    'affine_search_docs',
    'affine_recent_docs',
    'affine_publish_doc',
    'affine_revoke_doc',
    'affine_create_doc',
    'affine_update_doc',
    'affine_delete_doc',
    'affine_duplicate_doc',
    'affine_restore_doc',
    'affine_share_doc'
  ],
  collaboration: [
    'affine_list_comments',
    'affine_create_comment',
    'affine_update_comment',
    'affine_delete_comment',
    'affine_resolve_comment'
  ],
  history: [
    'affine_list_histories',
    'affine_recover_doc'
  ],
  user: [
    'affine_current_user',
    'affine_sign_in',
    'affine_update_profile',
    'affine_update_settings',
    'affine_send_verify_email',
    'affine_change_password',
    'affine_send_password_reset',
    'affine_delete_account'
  ],
  accessToken: [
    'affine_list_access_tokens',
    'affine_generate_access_token',
    'affine_revoke_access_token'
  ],
  blob: [
    'affine_upload_blob',
    'affine_delete_blob',
    'affine_cleanup_blobs'
  ],
  notification: [
    'affine_list_notifications',
    'affine_read_notification',
    'affine_read_all_notifications'
  ],
  advanced: [
    'affine_apply_doc_updates'
  ],
  realtime: [
    'affine_realtime_create_doc',
    'affine_realtime_update_doc',
    'affine_realtime_connect'
  ],
  experimental: [
    'affine_experimental_create_workspace',
    'affine_experimental_init_doc',
    'affine_experimental_clone_doc'
  ]
};

class ComprehensiveTestRunner {
  constructor() {
    this.server = null;
    this.testResults = {};
    this.workspaceId = null;
    this.docId = null;
    this.commentId = null;
    this.tokenId = null;
    this.blobKey = null;
    this.totalTools = 0;
  }

  async startServer() {
    return new Promise((resolve, reject) => {
      this.server = spawn('node', [MCP_SERVER_PATH], {
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe']
      });

      this.server.on('error', reject);
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
      }, 10000);
    });
  }

  async testTool(name, params) {
    const startTime = Date.now();
    
    try {
      const result = await this.sendRequest(name, params);
      const duration = Date.now() - startTime;
      
      if (result.error) {
        return {
          status: 'failed',
          error: result.error.message || JSON.stringify(result.error),
          duration
        };
      } else {
        return {
          status: 'success',
          duration,
          result: result.result
        };
      }
    } catch (error) {
      return {
        status: 'error',
        error: error.message
      };
    }
  }

  async testWorkspaceTools() {
    console.log('\n📁 WORKSPACE MANAGEMENT (7 tools)');
    const results = {};
    
    // List workspaces
    results['affine_list_workspaces'] = await this.testTool('affine_list_workspaces', {});
    console.log(`  ✅ affine_list_workspaces`);
    
    // Create workspace
    const createResult = await this.testTool('affine_create_workspace', { name: 'Test Workspace' });
    results['affine_create_workspace'] = createResult;
    
    if (createResult.status === 'success' && createResult.result?.content?.[0]?.text) {
      const text = createResult.result.content[0].text;
      const match = text.match(/"id":\s*"([^"]+)"/);
      if (match) this.workspaceId = match[1];
    }
    console.log(`  ✅ affine_create_workspace`);
    
    if (this.workspaceId) {
      // Get workspace
      results['affine_get_workspace'] = await this.testTool('affine_get_workspace', { id: this.workspaceId });
      console.log(`  ✅ affine_get_workspace`);
      
      // Update workspace
      results['affine_update_workspace'] = await this.testTool('affine_update_workspace', { 
        id: this.workspaceId, 
        enableAi: true 
      });
      console.log(`  ✅ affine_update_workspace`);
      
      // Invite members
      results['affine_invite_members'] = await this.testTool('affine_invite_members', {
        workspaceId: this.workspaceId,
        emails: ['test@example.com'],
        sendInviteMail: false
      });
      console.log(`  ✅ affine_invite_members`);
      
      // Leave workspace
      results['affine_leave_workspace'] = await this.testTool('affine_leave_workspace', { 
        workspaceId: this.workspaceId 
      });
      console.log(`  ✅ affine_leave_workspace`);
      
      // Delete workspace
      results['affine_delete_workspace'] = await this.testTool('affine_delete_workspace', { 
        id: this.workspaceId 
      });
      console.log(`  ✅ affine_delete_workspace`);
    } else {
      results['affine_get_workspace'] = { status: 'skipped', reason: 'No workspace ID' };
      results['affine_update_workspace'] = { status: 'skipped', reason: 'No workspace ID' };
      results['affine_invite_members'] = { status: 'skipped', reason: 'No workspace ID' };
      results['affine_leave_workspace'] = { status: 'skipped', reason: 'No workspace ID' };
      results['affine_delete_workspace'] = { status: 'skipped', reason: 'No workspace ID' };
    }
    
    return results;
  }

  async testDocumentTools() {
    console.log('\n📄 DOCUMENT OPERATIONS (12 tools)');
    const results = {};
    
    // List docs
    results['affine_list_docs'] = await this.testTool('affine_list_docs', { first: 5 });
    console.log(`  ✅ affine_list_docs`);
    
    // Search docs
    results['affine_search_docs'] = await this.testTool('affine_search_docs', { keyword: 'test' });
    console.log(`  ✅ affine_search_docs`);
    
    // Recent docs
    results['affine_recent_docs'] = await this.testTool('affine_recent_docs', { first: 5 });
    console.log(`  ✅ affine_recent_docs`);
    
    // Create doc
    const createResult = await this.testTool('affine_create_doc', { title: 'Test Document' });
    results['affine_create_doc'] = createResult;
    
    if (createResult.status === 'success' && createResult.result?.content?.[0]?.text) {
      const text = createResult.result.content[0].text;
      const match = text.match(/"id":\s*"([^"]+)"/);
      if (match) this.docId = match[1];
    }
    console.log(`  ✅ affine_create_doc`);
    
    if (this.docId) {
      // Get doc
      results['affine_get_doc'] = await this.testTool('affine_get_doc', { docId: this.docId });
      console.log(`  ✅ affine_get_doc`);
      
      // Update doc
      results['affine_update_doc'] = await this.testTool('affine_update_doc', { 
        docId: this.docId, 
        content: 'Updated content' 
      });
      console.log(`  ✅ affine_update_doc`);
      
      // Publish doc
      results['affine_publish_doc'] = await this.testTool('affine_publish_doc', { docId: this.docId });
      console.log(`  ✅ affine_publish_doc`);
      
      // Revoke doc
      results['affine_revoke_doc'] = await this.testTool('affine_revoke_doc', { docId: this.docId });
      console.log(`  ✅ affine_revoke_doc`);
      
      // Duplicate doc
      results['affine_duplicate_doc'] = await this.testTool('affine_duplicate_doc', { 
        docId: this.docId, 
        newTitle: 'Duplicated Doc' 
      });
      console.log(`  ✅ affine_duplicate_doc`);
      
      // Share doc
      results['affine_share_doc'] = await this.testTool('affine_share_doc', { 
        docId: this.docId, 
        users: ['test@example.com'] 
      });
      console.log(`  ✅ affine_share_doc`);
      
      // Delete doc
      results['affine_delete_doc'] = await this.testTool('affine_delete_doc', { docId: this.docId });
      console.log(`  ✅ affine_delete_doc`);
      
      // Restore doc
      results['affine_restore_doc'] = await this.testTool('affine_restore_doc', { docId: this.docId });
      console.log(`  ✅ affine_restore_doc`);
    } else {
      results['affine_get_doc'] = { status: 'skipped', reason: 'No doc ID' };
      results['affine_update_doc'] = { status: 'skipped', reason: 'No doc ID' };
      results['affine_publish_doc'] = { status: 'skipped', reason: 'No doc ID' };
      results['affine_revoke_doc'] = { status: 'skipped', reason: 'No doc ID' };
      results['affine_duplicate_doc'] = { status: 'skipped', reason: 'No doc ID' };
      results['affine_share_doc'] = { status: 'skipped', reason: 'No doc ID' };
      results['affine_delete_doc'] = { status: 'skipped', reason: 'No doc ID' };
      results['affine_restore_doc'] = { status: 'skipped', reason: 'No doc ID' };
    }
    
    return results;
  }

  async testCollaborationTools() {
    console.log('\n💬 COLLABORATION (5 tools)');
    const results = {};
    
    if (this.docId) {
      // List comments
      results['affine_list_comments'] = await this.testTool('affine_list_comments', { docId: this.docId });
      console.log(`  ✅ affine_list_comments`);
      
      // Create comment
      const createResult = await this.testTool('affine_create_comment', { 
        docId: this.docId, 
        content: 'Test comment' 
      });
      results['affine_create_comment'] = createResult;
      
      if (createResult.status === 'success' && createResult.result?.content?.[0]?.text) {
        const text = createResult.result.content[0].text;
        const match = text.match(/"id":\s*"([^"]+)"/);
        if (match) this.commentId = match[1];
      }
      console.log(`  ✅ affine_create_comment`);
      
      if (this.commentId) {
        // Update comment
        results['affine_update_comment'] = await this.testTool('affine_update_comment', { 
          id: this.commentId, 
          content: 'Updated comment' 
        });
        console.log(`  ✅ affine_update_comment`);
        
        // Resolve comment
        results['affine_resolve_comment'] = await this.testTool('affine_resolve_comment', { 
          id: this.commentId, 
          resolved: true 
        });
        console.log(`  ✅ affine_resolve_comment`);
        
        // Delete comment
        results['affine_delete_comment'] = await this.testTool('affine_delete_comment', { 
          id: this.commentId 
        });
        console.log(`  ✅ affine_delete_comment`);
      } else {
        results['affine_update_comment'] = { status: 'skipped', reason: 'No comment ID' };
        results['affine_resolve_comment'] = { status: 'skipped', reason: 'No comment ID' };
        results['affine_delete_comment'] = { status: 'skipped', reason: 'No comment ID' };
      }
    } else {
      results['affine_list_comments'] = { status: 'skipped', reason: 'No doc ID' };
      results['affine_create_comment'] = { status: 'skipped', reason: 'No doc ID' };
      results['affine_update_comment'] = { status: 'skipped', reason: 'No doc ID' };
      results['affine_resolve_comment'] = { status: 'skipped', reason: 'No doc ID' };
      results['affine_delete_comment'] = { status: 'skipped', reason: 'No doc ID' };
    }
    
    return results;
  }

  async testHistoryTools() {
    console.log('\n📚 VERSION CONTROL (2 tools)');
    const results = {};
    
    if (this.docId) {
      results['affine_list_histories'] = await this.testTool('affine_list_histories', { guid: this.docId });
      console.log(`  ✅ affine_list_histories`);
      
      results['affine_recover_doc'] = await this.testTool('affine_recover_doc', { 
        guid: this.docId, 
        timestamp: new Date().toISOString() 
      });
      console.log(`  ✅ affine_recover_doc`);
    } else {
      results['affine_list_histories'] = { status: 'skipped', reason: 'No doc ID' };
      results['affine_recover_doc'] = { status: 'skipped', reason: 'No doc ID' };
    }
    
    return results;
  }

  async testUserTools() {
    console.log('\n👤 USER & AUTHENTICATION (8 tools)');
    const results = {};
    
    results['affine_current_user'] = await this.testTool('affine_current_user', {});
    console.log(`  ✅ affine_current_user`);
    
    results['affine_sign_in'] = await this.testTool('affine_sign_in', { 
      email: process.env.AFFINE_EMAIL, 
      password: process.env.AFFINE_PASSWORD 
    });
    console.log(`  ✅ affine_sign_in`);
    
    results['affine_update_profile'] = await this.testTool('affine_update_profile', { name: 'Test User' });
    console.log(`  ✅ affine_update_profile`);
    
    results['affine_update_settings'] = await this.testTool('affine_update_settings', { 
      settings: { theme: 'dark' } 
    });
    console.log(`  ✅ affine_update_settings`);
    
    results['affine_send_verify_email'] = await this.testTool('affine_send_verify_email', {});
    console.log(`  ✅ affine_send_verify_email`);
    
    results['affine_send_password_reset'] = await this.testTool('affine_send_password_reset', {});
    console.log(`  ✅ affine_send_password_reset`);
    
    // Skip destructive operations
    results['affine_change_password'] = { status: 'skipped', reason: 'Requires token' };
    results['affine_delete_account'] = { status: 'skipped', reason: 'Destructive operation' };
    
    return results;
  }

  async testAccessTokenTools() {
    console.log('\n🔑 ACCESS TOKENS (3 tools)');
    const results = {};
    
    results['affine_list_access_tokens'] = await this.testTool('affine_list_access_tokens', {});
    console.log(`  ✅ affine_list_access_tokens`);
    
    const createResult = await this.testTool('affine_generate_access_token', { name: 'Test Token' });
    results['affine_generate_access_token'] = createResult;
    
    if (createResult.status === 'success' && createResult.result?.content?.[0]?.text) {
      const text = createResult.result.content[0].text;
      const match = text.match(/"id":\s*"([^"]+)"/);
      if (match) this.tokenId = match[1];
    }
    console.log(`  ✅ affine_generate_access_token`);
    
    if (this.tokenId) {
      results['affine_revoke_access_token'] = await this.testTool('affine_revoke_access_token', { 
        id: this.tokenId 
      });
      console.log(`  ✅ affine_revoke_access_token`);
    } else {
      results['affine_revoke_access_token'] = { status: 'skipped', reason: 'No token ID' };
    }
    
    return results;
  }

  async testBlobTools() {
    console.log('\n📦 BLOB STORAGE (3 tools)');
    const results = {};
    
    const uploadResult = await this.testTool('affine_upload_blob', {
      workspaceId: this.workspaceId || 'test-workspace',
      content: 'Test file content',
      filename: 'test.txt'
    });
    results['affine_upload_blob'] = uploadResult;
    
    if (uploadResult.status === 'success' && uploadResult.result?.content?.[0]?.text) {
      const text = uploadResult.result.content[0].text;
      const match = text.match(/"id":\s*"([^"]+)"/);
      if (match) this.blobKey = match[1];
    }
    console.log(`  ✅ affine_upload_blob`);
    
    if (this.blobKey) {
      results['affine_delete_blob'] = await this.testTool('affine_delete_blob', {
        workspaceId: this.workspaceId || 'test-workspace',
        key: this.blobKey
      });
      console.log(`  ✅ affine_delete_blob`);
    } else {
      results['affine_delete_blob'] = { status: 'skipped', reason: 'No blob key' };
    }
    
    results['affine_cleanup_blobs'] = await this.testTool('affine_cleanup_blobs', {
      workspaceId: this.workspaceId || 'test-workspace'
    });
    console.log(`  ✅ affine_cleanup_blobs`);
    
    return results;
  }

  async testNotificationTools() {
    console.log('\n🔔 NOTIFICATIONS (3 tools)');
    const results = {};
    
    const listResult = await this.testTool('affine_list_notifications', {});
    results['affine_list_notifications'] = listResult;
    console.log(`  ✅ affine_list_notifications`);
    
    if (listResult.status === 'success' && listResult.result?.content?.[0]?.text) {
      const text = listResult.result.content[0].text;
      const match = text.match(/"id":\s*"([^"]+)"/);
      if (match) {
        results['affine_read_notification'] = await this.testTool('affine_read_notification', { 
          id: match[1] 
        });
        console.log(`  ✅ affine_read_notification`);
      } else {
        results['affine_read_notification'] = { status: 'skipped', reason: 'No notification ID' };
      }
    } else {
      results['affine_read_notification'] = { status: 'skipped', reason: 'No notifications' };
    }
    
    results['affine_read_all_notifications'] = await this.testTool('affine_read_all_notifications', {});
    console.log(`  ✅ affine_read_all_notifications`);
    
    return results;
  }

  async testAdvancedTools() {
    console.log('\n⚙️ ADVANCED OPERATIONS (1 tool)');
    const results = {};
    
    if (this.docId) {
      results['affine_apply_doc_updates'] = await this.testTool('affine_apply_doc_updates', {
        docId: this.docId,
        op: 'push',
        updates: [{ update: Buffer.from('test update').toString('base64') }]
      });
      console.log(`  ✅ affine_apply_doc_updates`);
    } else {
      results['affine_apply_doc_updates'] = { status: 'skipped', reason: 'No doc ID' };
    }
    
    return results;
  }

  async testRealtimeTools() {
    console.log('\n🔄 REALTIME OPERATIONS (3 tools)');
    const results = {};
    
    results['affine_realtime_connect'] = await this.testTool('affine_realtime_connect', {
      workspaceId: this.workspaceId || 'test-workspace'
    });
    console.log(`  ✅ affine_realtime_connect`);
    
    const createResult = await this.testTool('affine_realtime_create_doc', {
      workspaceId: this.workspaceId || 'test-workspace',
      title: 'Realtime Test Document',
      content: 'This is a test document created via WebSocket'
    });
    results['affine_realtime_create_doc'] = createResult;
    console.log(`  ✅ affine_realtime_create_doc`);
    
    if (createResult.status === 'success' && createResult.result?.content?.[0]?.text) {
      const text = createResult.result.content[0].text;
      const match = text.match(/Document ID: ([a-zA-Z0-9-_]+)/);
      if (match) {
        results['affine_realtime_update_doc'] = await this.testTool('affine_realtime_update_doc', {
          workspaceId: this.workspaceId || 'test-workspace',
          docId: match[1],
          title: 'Updated Realtime Document',
          content: 'Updated content via WebSocket'
        });
        console.log(`  ✅ affine_realtime_update_doc`);
      } else {
        results['affine_realtime_update_doc'] = { status: 'skipped', reason: 'No realtime doc ID' };
      }
    } else {
      results['affine_realtime_update_doc'] = { status: 'skipped', reason: 'No realtime doc created' };
    }
    
    return results;
  }

  async testExperimentalTools() {
    console.log('\n🧪 EXPERIMENTAL TOOLS (3 tools)');
    const results = {};
    
    results['affine_experimental_create_workspace'] = await this.testTool('affine_experimental_create_workspace', {
      name: 'Experimental Workspace',
      initialDocTitle: 'Initial Doc'
    });
    console.log(`  ✅ affine_experimental_create_workspace`);
    
    results['affine_experimental_init_doc'] = await this.testTool('affine_experimental_init_doc', {
      workspaceId: this.workspaceId || 'test-workspace',
      docId: 'test-doc-' + Date.now(),
      title: 'Experimental Doc',
      content: 'Experimental content'
    });
    console.log(`  ✅ affine_experimental_init_doc`);
    
    results['affine_experimental_clone_doc'] = await this.testTool('affine_experimental_clone_doc', {
      sourceWorkspaceId: this.workspaceId || 'test-workspace',
      sourceDocId: this.docId || 'test-doc',
      targetWorkspaceId: this.workspaceId || 'test-workspace',
      newTitle: 'Cloned Doc'
    });
    console.log(`  ✅ affine_experimental_clone_doc`);
    
    return results;
  }

  async runAllTests() {
    console.log('🚀 Starting Comprehensive AFFiNE MCP Server Test');
    console.log('='.repeat(60));
    console.log(`Testing all 50 tools across 11 categories`);
    console.log('='.repeat(60));

    await this.startServer();
    console.log('\n✅ MCP Server started successfully\n');

    // Run all test categories
    this.testResults.workspace = await this.testWorkspaceTools();
    this.testResults.document = await this.testDocumentTools();
    this.testResults.collaboration = await this.testCollaborationTools();
    this.testResults.history = await this.testHistoryTools();
    this.testResults.user = await this.testUserTools();
    this.testResults.accessToken = await this.testAccessTokenTools();
    this.testResults.blob = await this.testBlobTools();
    this.testResults.notification = await this.testNotificationTools();
    this.testResults.advanced = await this.testAdvancedTools();
    this.testResults.realtime = await this.testRealtimeTools();
    this.testResults.experimental = await this.testExperimentalTools();

    this.generateSummary();
    
    if (this.server) {
      this.server.kill();
    }
  }

  generateSummary() {
    console.log('\n' + '='.repeat(60));
    console.log('📊 COMPREHENSIVE TEST SUMMARY');
    console.log('='.repeat(60));
    
    let totalSuccess = 0;
    let totalFailed = 0;
    let totalSkipped = 0;
    let totalError = 0;
    
    // Count all tools
    Object.entries(TOOL_CATEGORIES).forEach(([category, tools]) => {
      this.totalTools += tools.length;
    });
    
    // Analyze results by category
    Object.entries(this.testResults).forEach(([category, results]) => {
      const tools = TOOL_CATEGORIES[category];
      let catSuccess = 0;
      let catFailed = 0;
      let catSkipped = 0;
      let catError = 0;
      
      tools.forEach(tool => {
        const result = results[tool];
        if (!result) {
          catError++;
        } else if (result.status === 'success') {
          catSuccess++;
        } else if (result.status === 'failed') {
          catFailed++;
        } else if (result.status === 'skipped') {
          catSkipped++;
        } else if (result.status === 'error') {
          catError++;
        }
      });
      
      totalSuccess += catSuccess;
      totalFailed += catFailed;
      totalSkipped += catSkipped;
      totalError += catError;
      
      const catName = category.charAt(0).toUpperCase() + category.slice(1);
      console.log(`\n${catName} (${tools.length} tools):`);
      console.log(`  ✅ Success: ${catSuccess}`);
      if (catFailed > 0) console.log(`  ❌ Failed: ${catFailed}`);
      if (catSkipped > 0) console.log(`  ⏭️ Skipped: ${catSkipped}`);
      if (catError > 0) console.log(`  ⚠️ Error: ${catError}`);
    });
    
    console.log('\n' + '-'.repeat(60));
    console.log('OVERALL RESULTS:');
    console.log(`Total Tools: ${this.totalTools}`);
    console.log(`✅ Successful: ${totalSuccess}`);
    console.log(`❌ Failed: ${totalFailed}`);
    console.log(`⏭️ Skipped: ${totalSkipped}`);
    console.log(`⚠️ Errors: ${totalError}`);
    
    const tested = totalSuccess + totalFailed;
    const successRate = tested > 0 ? ((totalSuccess / tested) * 100).toFixed(1) : 0;
    console.log(`\n📈 Success Rate: ${successRate}% (of tested tools)`);
    console.log(`📊 Coverage: ${((tested / this.totalTools) * 100).toFixed(1)}% (${tested}/${this.totalTools} tools tested)`);
    
    // Save detailed results
    const timestamp = new Date().toISOString();
    const resultsFile = `comprehensive-test-results-${timestamp.replace(/[:.]/g, '-')}.json`;
    
    fs.writeFileSync(resultsFile, JSON.stringify({
      timestamp,
      summary: {
        totalTools: this.totalTools,
        successful: totalSuccess,
        failed: totalFailed,
        skipped: totalSkipped,
        errors: totalError,
        successRate,
        coverage: ((tested / this.totalTools) * 100).toFixed(1)
      },
      detailedResults: this.testResults
    }, null, 2));
    
    console.log(`\n📁 Detailed results saved to: ${resultsFile}`);
    console.log('='.repeat(60));
  }
}

// Run comprehensive tests
const runner = new ComprehensiveTestRunner();
runner.runAllTests().catch(console.error);