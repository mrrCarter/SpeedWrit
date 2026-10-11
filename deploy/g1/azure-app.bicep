targetScope = 'resourceGroup'

param location string = resourceGroup().location
param appName string = 'speedwrit-g1'
param environmentId string
param environmentDomain string
param registryServer string
param pullIdentityId string
param image string
param googleClientId string
@minLength(1)
param demoRecipients string
param ownerAppContacts string = '[]'
param jobPurpose string = 'Send a recap of our call.'
@secure()
param databaseUrl string
@secure()
param googleClientSecret string
@secure()
param receiptSigningKey string
@secure()
param custodyKey string

var host = 'https://${appName}.${environmentDomain}'

resource app 'Microsoft.App/containerApps@2025-01-01' = {
  name: appName
  location: location
  tags: { project: 'SpeedWrit', lane: 'G1', event: '2026-10-11' }
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${pullIdentityId}': {} }
  }
  properties: {
    managedEnvironmentId: environmentId
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: { external: true, targetPort: 8080, allowInsecure: false, transport: 'auto' }
      registries: [{ server: registryServer, identity: pullIdentityId }]
      secrets: [
        { name: 'database-url', value: databaseUrl }
        { name: 'google-secret', value: googleClientSecret }
        { name: 'receipt-signing-key', value: receiptSigningKey }
        { name: 'custody-key', value: custodyKey }
      ]
    }
    template: {
      scale: { minReplicas: 1, maxReplicas: 1 }
      containers: [{
        name: 'speedwrit'
        image: image
        resources: { cpu: json('0.5'), memory: '1Gi' }
        env: [
          { name: 'HOST', value: host }
          { name: 'PORT', value: '8080' }
          { name: 'OWNER_APP_DIR', value: '/app/packages/job-send-ui/dist/owner-app' }
          { name: 'GOOGLE_CLIENT_ID', value: googleClientId }
          { name: 'GOOGLE_CLIENT_SECRET', secretRef: 'google-secret' }
          { name: 'DATABASE_URL', secretRef: 'database-url' }
          { name: 'RECEIPT_SIGNING_KEY', secretRef: 'receipt-signing-key' }
          { name: 'CUSTODY_KEY', secretRef: 'custody-key' }
          { name: 'DEMO_RECIPIENTS', value: demoRecipients }
          { name: 'OWNER_APP_CONTACTS', value: ownerAppContacts }
          { name: 'JOB_PURPOSE', value: jobPurpose }
          { name: 'SECRET_PATH_FALLBACK', value: 'off' }
          { name: 'ACCESS_LOG', value: 'on' }
        ]
        probes: [
          { type: 'Startup', tcpSocket: { port: 8080 }, periodSeconds: 30, failureThreshold: 10 }
          { type: 'Liveness', tcpSocket: { port: 8080 }, periodSeconds: 30, failureThreshold: 3 }
          { type: 'Readiness', httpGet: { port: 8080, path: '/.well-known/oauth-protected-resource/mcp' }, periodSeconds: 10, failureThreshold: 3 }
        ]
      }]
    }
  }
}

output host string = host
output appId string = app.id
