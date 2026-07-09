import { createWorkflow, createNode, connect } from '../lib/workflow.js';

// Adopted from the server-only "Contacts Management" workflow (id LW7p9cmX1ZtuQBmT).
// Node parameters are inlined verbatim from the live workflow for fidelity.

const n_user_unsubscribe = createNode(
  "User Unsubscribe",
  "n8n-nodes-base.mailchimpTrigger",
  {
    "authentication": "oAuth2",
    "list": "77d135987f",
    "events": [
      "unsubscribe"
    ],
    "sources": [
      "user",
      "admin",
      "api"
    ]
  },
  {
    "typeVersion": 1,
    "position": [
      -64,
      160
    ],
    "id": "6176fa82-ca68-4eec-96b7-ce780d0680f4",
    "credentials": {
      "mailchimpOAuth2Api": {
        "id": "DtyHZOOulvefkbC3",
        "name": "Mailchimp account"
      }
    },
    "disabled": true
  },
);
n_user_unsubscribe.webhookId = "99e2afc1-1411-4d6a-b07b-35d47109b995";

const n_webflow_trigger_form_submission = createNode(
  "Webflow Trigger: Form Submission",
  "n8n-nodes-base.webflowTrigger",
  {
    "site": "66022db75af9853636d1ce23"
  },
  {
    "typeVersion": 2,
    "position": [
      -64,
      -400
    ],
    "id": "7d35e546-efac-4a9f-8890-7042f0d6a08a",
    "credentials": {
      "webflowOAuth2Api": {
        "id": "7uo2MfFKQm2Xiodm",
        "name": "Webflow account"
      }
    }
  },
);
n_webflow_trigger_form_submission.webhookId = "3045ec6b-b720-4fa8-826f-452e883f6665";

const n_validate_email = createNode(
  "Validate Email",
  "n8n-nodes-base.httpRequest",
  {
    "url": "=https://api.usercheck.com/email/{{ $json.payload.data[\"Contact 1 Email 2\"] }}",
    "authentication": "genericCredentialType",
    "genericAuthType": "httpHeaderAuth",
    "sendQuery": true,
    "queryParameters": {
      "parameters": [
        {}
      ]
    },
    "options": {}
  },
  {
    "typeVersion": 4.2,
    "position": [
      384,
      -672
    ],
    "id": "6c9952dc-4730-4bfb-a29d-7875f034a0cd",
    "credentials": {
      "httpHeaderAuth": {
        "id": "sGklpGDze5oWu3MF",
        "name": "UserCheck API"
      }
    }
  },
);

const n_notion_copy_to_master_contacts = createNode(
  "Notion: Copy to Master Contacts",
  "n8n-nodes-base.notion",
  {
    "resource": "databasePage",
    "databaseId": {
      "__rl": true,
      "value": "1688ebaf-15ee-806b-bd12-dd7c8caf2bdd",
      "mode": "list",
      "cachedResultName": "Web DB: Master Contacts",
      "cachedResultUrl": "https://www.notion.so/1688ebaf15ee806bbd12dd7c8caf2bdd"
    },
    "propertiesUi": {
      "propertyValues": [
        {
          "key": "Email|email",
          "emailValue": "={{ $json.email }}"
        },
        {
          "key": "First name|rich_text",
          "textContent": "={{ $json.name_parsed.firstName }}"
        },
        {
          "key": "Last name|rich_text",
          "textContent": "={{ $json.name_parsed.lastName }}"
        },
        {
          "key": "Identifier|title",
          "title": "={{ $json.email }}"
        },
        {
          "key": "Email Marketing|select",
          "selectValue": "Subscribed"
        },
        {
          "key": "Contact form msg|rich_text",
          "textContent": "={{ ($json.payload.data[\"Contact 1 Message 2\"].length >= 500)? $json.payload.data[\"Contact 1 Message 2\"].slice(0,500)+\"...\" : $json.payload.data[\"Contact 1 Message 2\"]  }}"
        },
        {
          "key": "Sources|multi_select",
          "multiSelectValue": [
            "contact form"
          ]
        }
      ]
    },
    "options": {}
  },
  {
    "typeVersion": 2.2,
    "position": [
      1264,
      -496
    ],
    "id": "5b6b01e2-5678-42b1-bee4-1d52de437443",
    "credentials": {
      "notionApi": {
        "id": "lOLrwKiRnGrhZ9xM",
        "name": "Eve Notion Account"
      }
    }
  },
);
n_notion_copy_to_master_contacts.retryOnFail = true;

const n_notion = createNode(
  "Notion",
  "n8n-nodes-base.notion",
  {
    "resource": "databasePage",
    "operation": "getAll",
    "databaseId": {
      "__rl": true,
      "value": "1148ebaf-15ee-8079-9917-c5158470b3e0",
      "mode": "list",
      "cachedResultName": "Web DB: Downloads",
      "cachedResultUrl": "https://www.notion.so/1148ebaf15ee80799917c5158470b3e0"
    },
    "filterType": "manual",
    "filters": {
      "conditions": [
        {
          "key": "Title|title",
          "condition": "equals",
          "titleValue": "={{ $('Merge1').item.json.payload.data.whitepaper }}"
        }
      ]
    },
    "options": {}
  },
  {
    "typeVersion": 2.2,
    "position": [
      1264,
      -304
    ],
    "id": "81020edf-64e1-47e5-9956-f8f91f8fff4f",
    "credentials": {
      "notionApi": {
        "id": "lOLrwKiRnGrhZ9xM",
        "name": "Eve Notion Account"
      }
    }
  },
);
n_notion.retryOnFail = true;

const n_matching_paper_found = createNode(
  "Matching paper found",
  "n8n-nodes-base.filter",
  {
    "conditions": {
      "options": {
        "caseSensitive": true,
        "leftValue": "",
        "typeValidation": "strict",
        "version": 2
      },
      "conditions": [
        {
          "id": "c442bd72-d28c-4cfd-92e4-e390294b569e",
          "leftValue": "={{ $json.id }}",
          "rightValue": "",
          "operator": {
            "type": "string",
            "operation": "notEmpty",
            "singleValue": true
          }
        }
      ],
      "combinator": "and"
    },
    "options": {}
  },
  {
    "typeVersion": 2.2,
    "position": [
      1488,
      -304
    ],
    "id": "3a69ee27-0eb9-46df-a721-ea03480623c2"
  },
);

const n_switch_by_form = createNode(
  "Switch by Form",
  "n8n-nodes-base.switch",
  {
    "rules": {
      "values": [
        {
          "conditions": {
            "options": {
              "caseSensitive": true,
              "leftValue": "",
              "typeValidation": "strict",
              "version": 2
            },
            "conditions": [
              {
                "leftValue": "={{ $json.payload.name }}",
                "rightValue": "Email Form",
                "operator": {
                  "type": "string",
                  "operation": "equals"
                }
              }
            ],
            "combinator": "and"
          },
          "renameOutput": true,
          "outputKey": "Email Form"
        },
        {
          "conditions": {
            "options": {
              "caseSensitive": true,
              "leftValue": "",
              "typeValidation": "strict",
              "version": 2
            },
            "conditions": [
              {
                "id": "7df3b947-93a2-4d74-96bc-dcd164b5c40d",
                "leftValue": "={{ $json.payload.name }}",
                "rightValue": "CTA Form",
                "operator": {
                  "type": "string",
                  "operation": "equals",
                  "name": "filter.operator.equals"
                }
              }
            ],
            "combinator": "and"
          },
          "renameOutput": true,
          "outputKey": "Download Form"
        }
      ]
    },
    "options": {}
  },
  {
    "typeVersion": 3.2,
    "position": [
      160,
      -400
    ],
    "id": "aa59712b-fe20-4fec-87ed-cf3a8a32ee78"
  },
);

const n_validate_email1 = createNode(
  "Validate Email1",
  "n8n-nodes-base.httpRequest",
  {
    "url": "=https://api.usercheck.com/email/{{ $json.payload.data[\"Email 2\"] }}",
    "authentication": "genericCredentialType",
    "genericAuthType": "httpHeaderAuth",
    "sendQuery": true,
    "queryParameters": {
      "parameters": [
        {}
      ]
    },
    "options": {
      "batching": {
        "batch": {}
      }
    }
  },
  {
    "typeVersion": 4.2,
    "position": [
      384,
      -128
    ],
    "id": "8a68400e-67b9-4475-9cff-6a427ee5f3f7",
    "credentials": {
      "httpHeaderAuth": {
        "id": "sGklpGDze5oWu3MF",
        "name": "UserCheck API"
      }
    }
  },
);

const n_notion_copy_to_master_contacts1 = createNode(
  "Notion: Copy to Master Contacts1",
  "n8n-nodes-base.notion",
  {
    "resource": "databasePage",
    "databaseId": {
      "__rl": true,
      "value": "1688ebaf-15ee-806b-bd12-dd7c8caf2bdd",
      "mode": "list",
      "cachedResultName": "Web DB: Master Contacts",
      "cachedResultUrl": "https://www.notion.so/1688ebaf15ee806bbd12dd7c8caf2bdd"
    },
    "propertiesUi": {
      "propertyValues": [
        {
          "key": "Email|email",
          "emailValue": "={{ $json.email }}"
        },
        {
          "key": "Email Marketing|select",
          "selectValue": "Subscribed"
        },
        {
          "key": "Sources|multi_select",
          "multiSelectValue": [
            "paper download"
          ]
        },
        {
          "key": "Identifier|title",
          "title": "={{ $json.email }}"
        }
      ]
    },
    "blockUi": {
      "blockValues": [
        {
          "textContent": "={{ $json.payload.data.whitepaper }}"
        }
      ]
    },
    "options": {}
  },
  {
    "typeVersion": 2.2,
    "position": [
      1040,
      -304
    ],
    "id": "836cd57d-30b3-4420-a84f-1e15c0f87f2c",
    "credentials": {
      "notionApi": {
        "id": "lOLrwKiRnGrhZ9xM",
        "name": "Eve Notion Account"
      }
    }
  },
);
n_notion_copy_to_master_contacts1.retryOnFail = true;

const n_merge = createNode(
  "Merge",
  "n8n-nodes-base.merge",
  {
    "mode": "combine",
    "advanced": true,
    "mergeByFields": {
      "values": [
        {
          "field1": "email",
          "field2": "payload.data[\"Contact 1 Email 2\"]"
        }
      ]
    },
    "options": {}
  },
  {
    "typeVersion": 3,
    "position": [
      592,
      -624
    ],
    "id": "484aa394-59a1-4458-9d28-5f946c6e4058"
  },
);

const n_merge1 = createNode(
  "Merge1",
  "n8n-nodes-base.merge",
  {
    "mode": "combine",
    "advanced": true,
    "mergeByFields": {
      "values": [
        {
          "field1": "payload.data[\"Email 2\"]",
          "field2": "email"
        }
      ]
    },
    "joinMode": "enrichInput1",
    "options": {}
  },
  {
    "typeVersion": 3,
    "position": [
      832,
      -208
    ],
    "id": "a1af6129-f6d8-4bae-a359-94013be379bd"
  },
);

const n_sticky_note = createNode(
  "Sticky Note",
  "n8n-nodes-base.stickyNote",
  {
    "content": "## Handle Basic Contact Form Submissions",
    "height": 460,
    "width": 1580,
    "color": 6
  },
  {
    "typeVersion": 1,
    "position": [
      304,
      -816
    ],
    "id": "c6cb5da3-7f64-4a88-bbd7-2c9bd6b0a185"
  },
);

const n_sticky_note1 = createNode(
  "Sticky Note1",
  "n8n-nodes-base.stickyNote",
  {
    "content": "## Handle Additionas, Changes, and Mailchimp Unsubscriptions",
    "height": 260,
    "width": 1200
  },
  {
    "typeVersion": 1,
    "position": [
      -144,
      112
    ],
    "id": "0b9b1e5b-619f-4f98-b688-65b9f7ec12a2",
    "disabled": true
  },
);

const n_sticky_note2 = createNode(
  "Sticky Note2",
  "n8n-nodes-base.stickyNote",
  {
    "content": "## Handle Contacts with Paper Download",
    "height": 420,
    "width": 1580,
    "color": 3
  },
  {
    "typeVersion": 1,
    "position": [
      304,
      -368
    ],
    "id": "92d15d9c-97ed-4200-b11b-86e25eb5c051"
  },
);

const n_parse_human_name = createNode(
  "Parse Human Name",
  "n8n-nodes-base.code",
  {
    "mode": "runOnceForEachItem",
    "jsCode": "const nameParse = require('humanname');\n\n$input.item.json.name_parsed = nameParse.parse($input.item.json.payload.data[\"Contact 1 Name 2\"])\nreturn $input.item;"
  },
  {
    "typeVersion": 2,
    "position": [
      1040,
      -608
    ],
    "id": "d6c8b51c-7c7e-43a7-9fcf-123fb0338757"
  },
);

const n_add_to_mailchimp1 = createNode(
  "Add to Mailchimp1",
  "n8n-nodes-base.executeWorkflow",
  {
    "workflowId": {
      "__rl": true,
      "value": "qvhhwm0l47pZnP8c",
      "mode": "list",
      "cachedResultName": "Create or Update Mailchimp Record"
    },
    "workflowInputs": {
      "mappingMode": "defineBelow",
      "value": {
        "email_address": "={{ $json.email }}",
        "status": "subscribed",
        "DOWNLOAD": "={{ $json.payload.data.whitepaper }}"
      },
      "matchingColumns": [],
      "schema": [
        {
          "id": "email_address",
          "displayName": "email_address",
          "required": false,
          "defaultMatch": false,
          "display": true,
          "canBeUsedToMatch": true,
          "type": "string"
        },
        {
          "id": "full_name",
          "displayName": "full_name",
          "required": false,
          "defaultMatch": false,
          "display": true,
          "canBeUsedToMatch": true,
          "type": "string"
        },
        {
          "id": "status",
          "displayName": "status",
          "required": false,
          "defaultMatch": false,
          "display": true,
          "canBeUsedToMatch": true,
          "type": "string"
        },
        {
          "id": "FNAME",
          "displayName": "FNAME",
          "required": false,
          "defaultMatch": false,
          "display": true,
          "canBeUsedToMatch": true,
          "type": "string",
          "removed": false
        },
        {
          "id": "LNAME",
          "displayName": "LNAME",
          "required": false,
          "defaultMatch": false,
          "display": true,
          "canBeUsedToMatch": true,
          "type": "string",
          "removed": false
        },
        {
          "id": "ADDRESS",
          "displayName": "ADDRESS",
          "required": false,
          "defaultMatch": false,
          "display": true,
          "canBeUsedToMatch": true,
          "type": "string",
          "removed": false
        },
        {
          "id": "PHONE",
          "displayName": "PHONE",
          "required": false,
          "defaultMatch": false,
          "display": true,
          "canBeUsedToMatch": true,
          "type": "string",
          "removed": false
        },
        {
          "id": "BIRTHDAY",
          "displayName": "BIRTHDAY",
          "required": false,
          "defaultMatch": false,
          "display": true,
          "canBeUsedToMatch": true,
          "type": "string",
          "removed": false
        },
        {
          "id": "COMPANY",
          "displayName": "COMPANY",
          "required": false,
          "defaultMatch": false,
          "display": true,
          "canBeUsedToMatch": true,
          "type": "string",
          "removed": false
        },
        {
          "id": "DOWNLOAD",
          "displayName": "DOWNLOAD",
          "required": false,
          "defaultMatch": false,
          "display": true,
          "canBeUsedToMatch": true,
          "type": "string",
          "removed": false
        }
      ],
      "attemptToConvertTypes": false,
      "convertFieldsToString": true
    },
    "options": {}
  },
  {
    "typeVersion": 1.2,
    "position": [
      1040,
      -96
    ],
    "id": "410e0937-b619-496a-ac74-01068bae7397"
  },
);

const n_add_to_mailchimp = createNode(
  "Add to Mailchimp",
  "n8n-nodes-base.executeWorkflow",
  {
    "workflowId": {
      "__rl": true,
      "value": "qvhhwm0l47pZnP8c",
      "mode": "list",
      "cachedResultName": "Create or Update Mailchimp Record"
    },
    "workflowInputs": {
      "mappingMode": "defineBelow",
      "value": {
        "email_address": "={{ $json.email }}",
        "full_name": "={{ $json.payload.data[\"Contact 1 Name 2\"] }}",
        "status": "subscribed",
        "FNAME": "={{ $json.name_parsed.firstName }}",
        "LNAME": "={{ $json.name_parsed.lastName }}"
      },
      "matchingColumns": [],
      "schema": [
        {
          "id": "email_address",
          "displayName": "email_address",
          "required": false,
          "defaultMatch": false,
          "display": true,
          "canBeUsedToMatch": true,
          "type": "string"
        },
        {
          "id": "full_name",
          "displayName": "full_name",
          "required": false,
          "defaultMatch": false,
          "display": true,
          "canBeUsedToMatch": true,
          "type": "string"
        },
        {
          "id": "status",
          "displayName": "status",
          "required": false,
          "defaultMatch": false,
          "display": true,
          "canBeUsedToMatch": true,
          "type": "string"
        },
        {
          "id": "FNAME",
          "displayName": "FNAME",
          "required": false,
          "defaultMatch": false,
          "display": true,
          "canBeUsedToMatch": true,
          "type": "string"
        },
        {
          "id": "LNAME",
          "displayName": "LNAME",
          "required": false,
          "defaultMatch": false,
          "display": true,
          "canBeUsedToMatch": true,
          "type": "string"
        },
        {
          "id": "ADDRESS",
          "displayName": "ADDRESS",
          "required": false,
          "defaultMatch": false,
          "display": true,
          "canBeUsedToMatch": true,
          "type": "string"
        },
        {
          "id": "PHONE",
          "displayName": "PHONE",
          "required": false,
          "defaultMatch": false,
          "display": true,
          "canBeUsedToMatch": true,
          "type": "string"
        },
        {
          "id": "BIRTHDAY",
          "displayName": "BIRTHDAY",
          "required": false,
          "defaultMatch": false,
          "display": true,
          "canBeUsedToMatch": true,
          "type": "string"
        },
        {
          "id": "COMPANY",
          "displayName": "COMPANY",
          "required": false,
          "defaultMatch": false,
          "display": true,
          "canBeUsedToMatch": true,
          "type": "string"
        },
        {
          "id": "DOWNLOAD",
          "displayName": "DOWNLOAD",
          "required": false,
          "defaultMatch": false,
          "display": true,
          "canBeUsedToMatch": true,
          "type": "string",
          "removed": false
        }
      ],
      "attemptToConvertTypes": false,
      "convertFieldsToString": true
    },
    "options": {}
  },
  {
    "typeVersion": 1.2,
    "position": [
      1264,
      -704
    ],
    "id": "60d8cf1c-8019-455d-87dc-9be5e801436f"
  },
);

const n_link_paper_reference = createNode(
  "Link Paper Reference",
  "n8n-nodes-base.httpRequest",
  {
    "method": "PATCH",
    "url": "=https://api.notion.com/v1/pages/{{ $('Notion: Copy to Master Contacts1').item.json.id }}",
    "authentication": "predefinedCredentialType",
    "nodeCredentialType": "notionApi",
    "sendBody": true,
    "specifyBody": "json",
    "jsonBody": "={\n  \"properties\": {\n    \"Papers\": {\n      \"relation\": [\n        {\"id\": \"{{ $json.id }}\" }\n      ]\n    }\n  }\n} ",
    "options": {}
  },
  {
    "typeVersion": 4.2,
    "position": [
      1712,
      -304
    ],
    "id": "a2e93608-8780-4fbb-9f0e-d019d84bdb6b",
    "credentials": {
      "notionApi": {
        "id": "lOLrwKiRnGrhZ9xM",
        "name": "Eve Notion Account"
      }
    }
  },
);
n_link_paper_reference.retryOnFail = true;

const n_not_spam = createNode(
  "Not Spam",
  "n8n-nodes-base.filter",
  {
    "conditions": {
      "options": {
        "caseSensitive": true,
        "leftValue": "",
        "typeValidation": "strict",
        "version": 2
      },
      "conditions": [
        {
          "id": "1c434aa7-1338-41fe-ac29-c9bde2cbadb9",
          "leftValue": "={{ $json.spam }}",
          "rightValue": "",
          "operator": {
            "type": "boolean",
            "operation": "exists",
            "singleValue": true
          }
        },
        {
          "id": "b0a85eb3-2d80-499e-9980-5ad5c2c8c32d",
          "leftValue": "={{ $json.mx }}",
          "rightValue": "",
          "operator": {
            "type": "boolean",
            "operation": "exists",
            "singleValue": true
          }
        },
        {
          "id": "c9361d08-e12a-4926-ac93-d69bc32e7427",
          "leftValue": "={{ $json.spam }}",
          "rightValue": "",
          "operator": {
            "type": "boolean",
            "operation": "false",
            "singleValue": true
          }
        },
        {
          "id": "d4f042e2-cfe8-4ecc-979e-5886192b68f0",
          "leftValue": "={{ $json.mx }}",
          "rightValue": "",
          "operator": {
            "type": "boolean",
            "operation": "true",
            "singleValue": true
          }
        }
      ],
      "combinator": "and"
    },
    "options": {}
  },
  {
    "typeVersion": 2.2,
    "position": [
      800,
      -624
    ],
    "id": "568e04b7-2658-44e1-bacc-dd2feb8cc2ca"
  },
);

const n_not_spam_2 = createNode(
  "Not Spam (2)",
  "n8n-nodes-base.filter",
  {
    "conditions": {
      "options": {
        "caseSensitive": true,
        "leftValue": "",
        "typeValidation": "strict",
        "version": 2
      },
      "conditions": [
        {
          "id": "4dbc76f3-3327-4f18-9ffc-d7f53f978ba7",
          "leftValue": "={{ $json.mx }}",
          "rightValue": "",
          "operator": {
            "type": "boolean",
            "operation": "true",
            "singleValue": true
          }
        },
        {
          "id": "1ae92cef-015c-4f86-819d-f66fa4a95523",
          "leftValue": "={{ $json.spam }}",
          "rightValue": "",
          "operator": {
            "type": "boolean",
            "operation": "false",
            "singleValue": true
          }
        }
      ],
      "combinator": "and"
    },
    "options": {}
  },
  {
    "typeVersion": 2.2,
    "position": [
      608,
      -128
    ],
    "id": "bb32ff29-ca4f-44d0-86bc-3d209c3a1afb"
  },
);

const n_edit_fields = createNode(
  "Edit Fields",
  "n8n-nodes-base.set",
  {
    "assignments": {
      "assignments": [
        {
          "id": "2d2813d0-f574-4b2b-93d2-08a48e84009e",
          "name": "type",
          "value": "={{ $json.type }}",
          "type": "string"
        },
        {
          "id": "ef2ec13d-fdf4-41aa-b200-f59a1beacbf5",
          "name": "fired_at",
          "value": "={{ $json.fired_at }}",
          "type": "string"
        },
        {
          "id": "2ab55d4a-ac44-4937-b9f7-b6aaf80f2fd0",
          "name": "data.list_id",
          "value": "={{ $json[\"data[list_id]\"] }}",
          "type": "string"
        },
        {
          "id": "b2c9184a-1561-4439-9259-050421fc3700",
          "name": "data.action",
          "value": "={{ $json[\"data[action]\"] }}",
          "type": "string"
        },
        {
          "id": "d04217e2-e3d9-4740-881d-077d12120b52",
          "name": "data.reason",
          "value": "={{ $json[\"data[reason]\"] }}",
          "type": "string"
        },
        {
          "id": "31d7193c-6f3e-4229-a825-510ac7087e1d",
          "name": "data.email",
          "value": "={{ $json[\"data[email]\"] }}",
          "type": "string"
        },
        {
          "id": "3d980228-9e6a-4be2-92ed-ae2d0a2a2175",
          "name": "data.ip_opt",
          "value": "={{ $json[\"data[ip_opt]\"] }}",
          "type": "string"
        },
        {
          "id": "6b21c78c-31e7-41d3-828c-0b2a42ff8be9",
          "name": "data.web_id",
          "value": "={{ $json[\"data[web_id]\"] }}",
          "type": "string"
        },
        {
          "id": "c40ff222-9be7-4798-80e5-669fda46dd5e",
          "name": "data.id",
          "value": "={{ $json[\"data[id]\"] }}",
          "type": "string"
        },
        {
          "id": "0b5e82e6-042c-446d-8c3c-b46aafb67063",
          "name": "data.merges.email",
          "value": "={{ $json[\"data[merges][EMAIL]\"] }}",
          "type": "string"
        },
        {
          "id": "5cfac0aa-3630-4776-9cd4-e717fc89147a",
          "name": "data.merges.FNAME",
          "value": "={{ $json[\"data[merges][FNAME]\"] }}",
          "type": "string"
        },
        {
          "id": "93bea4e7-62ff-438e-9f7d-5a6abc500743",
          "name": "data.merges.LNAME",
          "value": "={{ $json[\"data[merges][LNAME]\"] }}",
          "type": "string"
        },
        {
          "id": "2837357d-8a05-4293-bb61-fba6587a2864",
          "name": "data.merges.ADDRESS",
          "value": "={{ $json[\"data[merges][ADDRESS]\"] }}",
          "type": "string"
        },
        {
          "id": "e4540c3a-1c7e-4e03-a573-5b69cab24a01",
          "name": "data.merges.PHONE",
          "value": "={{ $json[\"data[merges][PHONE]\"] }}",
          "type": "string"
        },
        {
          "id": "f0f3e0a7-68cd-42d6-aca4-50955c738e0f",
          "name": "data.merges.BIRTHDAY",
          "value": "={{ $json[\"data[merges][BIRTHDAY]\"] }}",
          "type": "string"
        },
        {
          "id": "037d299d-4423-4a49-afa2-de7da0cddf09",
          "name": "data.merges.COMPANY",
          "value": "={{ $json[\"data[merges][COMPANY]\"] }}",
          "type": "string"
        },
        {
          "id": "e45af1b3-944c-457e-91a0-9a932da93a55",
          "name": "data.merges.TITLE",
          "value": "={{ $json[\"data[merges][TITLE]\"] }}",
          "type": "string"
        }
      ]
    },
    "options": {}
  },
  {
    "typeVersion": 3.4,
    "position": [
      160,
      160
    ],
    "id": "47a3b654-1d28-41c3-9f72-a83a73c17820",
    "disabled": true
  },
);

const n_notion1 = createNode(
  "Notion1",
  "n8n-nodes-base.notion",
  {
    "resource": "databasePage",
    "operation": "getAll",
    "databaseId": {
      "__rl": true,
      "value": "1688ebaf-15ee-806b-bd12-dd7c8caf2bdd",
      "mode": "list",
      "cachedResultName": "Web DB: Master Contacts",
      "cachedResultUrl": "https://www.notion.so/1688ebaf15ee806bbd12dd7c8caf2bdd"
    },
    "returnAll": true,
    "filterType": "manual",
    "matchType": "allFilters",
    "filters": {
      "conditions": [
        {
          "key": "Email|email",
          "condition": "equals",
          "emailValue": "={{ $json.data.email }}"
        }
      ]
    },
    "options": {}
  },
  {
    "typeVersion": 2.2,
    "position": [
      608,
      160
    ],
    "id": "129a0e30-2f09-40fe-9680-e6b753a08cd5",
    "credentials": {
      "notionApi": {
        "id": "lOLrwKiRnGrhZ9xM",
        "name": "Eve Notion Account"
      }
    },
    "disabled": true
  },
);
n_notion1.retryOnFail = true;

const n_notion2 = createNode(
  "Notion2",
  "n8n-nodes-base.notion",
  {
    "resource": "databasePage",
    "operation": "update",
    "pageId": {
      "__rl": true,
      "value": "={{ $json.id }}",
      "mode": "id"
    },
    "propertiesUi": {
      "propertyValues": [
        {
          "key": "Email Marketing|select",
          "selectValue": "Unsubscribed"
        }
      ]
    },
    "options": {}
  },
  {
    "typeVersion": 2.2,
    "position": [
      832,
      160
    ],
    "id": "97b4703b-2b16-4268-8a1a-d1c4ae109f5d",
    "credentials": {
      "notionApi": {
        "id": "lOLrwKiRnGrhZ9xM",
        "name": "Eve Notion Account"
      }
    },
    "disabled": true
  },
);
n_notion2.retryOnFail = true;

const n_filter = createNode(
  "Filter",
  "n8n-nodes-base.filter",
  {
    "conditions": {
      "options": {
        "caseSensitive": true,
        "leftValue": "",
        "typeValidation": "strict",
        "version": 2
      },
      "conditions": [
        {
          "id": "bb2fc06a-c8c7-40bd-a887-efaf8bfe0edf",
          "leftValue": "={{ $json.type }}",
          "rightValue": "unsubscribe",
          "operator": {
            "type": "string",
            "operation": "equals",
            "name": "filter.operator.equals"
          }
        }
      ],
      "combinator": "and"
    },
    "options": {}
  },
  {
    "typeVersion": 2.2,
    "position": [
      384,
      160
    ],
    "id": "b00cac9f-235c-49e9-8e0c-2f1391fea6f4",
    "disabled": true
  },
);

// Retry transient UserCheck 429s (rate-limit bursts) with a short backoff so a
// momentary "too many requests" retries instead of killing the run and dropping
// the form submission. (Fallback let-through on total failure is a follow-up.)
for (const _vn of [n_validate_email, n_validate_email1]) {
  _vn.retryOnFail = true;
  _vn.maxTries = 4;
  _vn.waitBetweenTries = 5000;
}

const workflow = createWorkflow("Contacts Management", {
  nodes: [
    n_user_unsubscribe,
    n_webflow_trigger_form_submission,
    n_validate_email,
    n_notion_copy_to_master_contacts,
    n_notion,
    n_matching_paper_found,
    n_switch_by_form,
    n_validate_email1,
    n_notion_copy_to_master_contacts1,
    n_merge,
    n_merge1,
    n_sticky_note,
    n_sticky_note1,
    n_sticky_note2,
    n_parse_human_name,
    n_add_to_mailchimp1,
    n_add_to_mailchimp,
    n_link_paper_reference,
    n_not_spam,
    n_not_spam_2,
    n_edit_fields,
    n_notion1,
    n_notion2,
    n_filter,
  ],
  connections: [
  connect(n_user_unsubscribe, n_edit_fields, 0, 0),
  connect(n_webflow_trigger_form_submission, n_switch_by_form, 0, 0),
  connect(n_validate_email, n_merge, 0, 0),
  connect(n_notion, n_matching_paper_found, 0, 0),
  connect(n_matching_paper_found, n_link_paper_reference, 0, 0),
  connect(n_switch_by_form, n_validate_email, 0, 0),
  connect(n_switch_by_form, n_merge, 0, 1),
  connect(n_switch_by_form, n_validate_email1, 1, 0),
  connect(n_switch_by_form, n_merge1, 1, 0),
  connect(n_validate_email1, n_not_spam_2, 0, 0),
  connect(n_notion_copy_to_master_contacts1, n_notion, 0, 0),
  connect(n_merge, n_not_spam, 0, 0),
  connect(n_merge1, n_notion_copy_to_master_contacts1, 0, 0),
  connect(n_merge1, n_add_to_mailchimp1, 0, 0),
  connect(n_parse_human_name, n_notion_copy_to_master_contacts, 0, 0),
  connect(n_parse_human_name, n_add_to_mailchimp, 0, 0),
  connect(n_not_spam, n_parse_human_name, 0, 0),
  connect(n_not_spam_2, n_merge1, 0, 1),
  connect(n_edit_fields, n_filter, 0, 0),
  connect(n_notion1, n_notion2, 0, 0),
  connect(n_filter, n_notion1, 0, 0),
  ],
  settings: {
    "executionOrder": "v1",
    "callerPolicy": "workflowsFromSameOwner",
    "errorWorkflow": "EZTb8m4htw60nP0b"
  },
  tags: ["Production","website"],
});

// Preserve server topology for empty / trailing-empty output slots.
while ((workflow.connections["Validate Email"].main || []).length < 2) workflow.connections["Validate Email"].main.push([]);
workflow.connections["Notion: Copy to Master Contacts"] = { main: [[]] };

export default workflow;
