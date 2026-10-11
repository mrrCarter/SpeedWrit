targetScope = 'resourceGroup'

param location string = resourceGroup().location
param prefix string = 'speedwrit-g1'
param databaseAdminLogin string = 'writadmin'
@secure()
param databasePassword string

var suffix = uniqueString(resourceGroup().id)
var tags = { project: 'SpeedWrit', lane: 'G1', event: '2026-10-11' }

resource network 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: '${prefix}-network'
  location: location
  tags: tags
  properties: {
    addressSpace: { addressPrefixes: ['10.71.0.0/16'] }
    subnets: [
      {
        name: 'apps'
        properties: {
          addressPrefix: '10.71.0.0/23'
          delegations: [{ name: 'apps', properties: { serviceName: 'Microsoft.App/environments' } }]
        }
      }
      {
        name: 'postgres'
        properties: {
          addressPrefix: '10.71.2.0/28'
          delegations: [{ name: 'postgres', properties: { serviceName: 'Microsoft.DBforPostgreSQL/flexibleServers' } }]
        }
      }
    ]
  }
}

resource privateDns 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: '${prefix}.postgres.database.azure.com'
  location: 'global'
  tags: tags
}

resource dnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: privateDns
  name: '${prefix}-link'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: { id: network.id }
  }
}

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: '${prefix}-${suffix}'
  location: location
  tags: tags
  sku: { name: 'Standard_B1ms', tier: 'Burstable' }
  properties: {
    version: '16'
    administratorLogin: databaseAdminLogin
    administratorLoginPassword: databasePassword
    storage: { storageSizeGB: 32, autoGrow: 'Enabled' }
    backup: { backupRetentionDays: 7, geoRedundantBackup: 'Disabled' }
    highAvailability: { mode: 'Disabled' }
    network: {
      delegatedSubnetResourceId: '${network.id}/subnets/postgres'
      privateDnsZoneArmResourceId: privateDns.id
      publicNetworkAccess: 'Disabled'
    }
  }
  dependsOn: [dnsLink]
}

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: postgres
  name: 'writ'
  properties: { charset: 'UTF8', collation: 'en_US.utf8' }
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: 'speedwrit${suffix}'
  location: location
  tags: tags
  sku: { name: 'Basic' }
  properties: { adminUserEnabled: false }
}

resource pullIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${prefix}-image-pull'
  location: location
  tags: tags
}

resource imagePullRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: registry
  name: guid(registry.id, pullIdentity.id, 'AcrPull')
  properties: {
    principalId: pullIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
  }
}

resource environment 'Microsoft.App/managedEnvironments@2025-01-01' = {
  name: '${prefix}-environment'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: { destination: 'none' }
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
    vnetConfiguration: {
      infrastructureSubnetId: '${network.id}/subnets/apps'
      internal: false
    }
  }
}

output environmentId string = environment.id
output environmentDomain string = environment.properties.defaultDomain
output registryName string = registry.name
output registryServer string = registry.properties.loginServer
output pullIdentityId string = pullIdentity.id
output databaseHost string = postgres.properties.fullyQualifiedDomainName
output databaseName string = database.name
