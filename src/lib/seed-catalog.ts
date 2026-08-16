// The closed-catalogue reference docs (config:colorchart / config:catalog /
// config:pricelist:tiendas) EXACTLY as loaded into production on 2026-08-15 —
// seeded in dev so ingress restrictions and the price prefill behave like the
// real app. Generated from the JSON files in docs/; regenerate, never hand-edit.
// Reference docs have no logic-module writer (they are plain config: documents,
// PUT to production the same way), so seeding them raw is the honest parallel.

export const CATALOG_DOCS = [
  {
    "_id": "config:colorchart",
    "type": "config",
    "chartName": "Carta de colores ML Textiles",
    "bands": {
      "1": "Blanco",
      "2": "Pasteles",
      "3": "Medios",
      "4": "Oscuros"
    },
    "colors": [
      {
        "code": "100",
        "name": "Blanco"
      },
      {
        "code": "200",
        "name": "Amarillo"
      },
      {
        "code": "201",
        "name": "Amarillo maiz"
      },
      {
        "code": "202",
        "name": "Amarillo colegial"
      },
      {
        "code": "203",
        "name": "Crudo"
      },
      {
        "code": "204",
        "name": "Perla"
      },
      {
        "code": "205",
        "name": "Verde boa"
      },
      {
        "code": "206",
        "name": "Beige colegial"
      },
      {
        "code": "207",
        "name": "Kaki"
      },
      {
        "code": "208",
        "name": "Azul cielo"
      },
      {
        "code": "209",
        "name": "Celeste"
      },
      {
        "code": "210",
        "name": "Celeste colegial"
      },
      {
        "code": "211",
        "name": "Gris lindo"
      },
      {
        "code": "212",
        "name": "Rosa vieja"
      },
      {
        "code": "213",
        "name": "Rosado"
      },
      {
        "code": "214",
        "name": "Guayaba"
      },
      {
        "code": "215",
        "name": "Melon"
      },
      {
        "code": "216",
        "name": "Salmon"
      },
      {
        "code": "217",
        "name": "Lila"
      },
      {
        "code": "218",
        "name": "Verde agua"
      },
      {
        "code": "219",
        "name": "Rosado bebe"
      },
      {
        "code": "220",
        "name": "Verde agua bebe"
      },
      {
        "code": "221",
        "name": "Lila bebe"
      },
      {
        "code": "222",
        "name": "Celeste bebe"
      },
      {
        "code": "223",
        "name": "Amarillo bebe"
      },
      {
        "code": "300",
        "name": "Azul medio"
      },
      {
        "code": "301",
        "name": "Azul italo"
      },
      {
        "code": "302",
        "name": "Azul belmont"
      },
      {
        "code": "303",
        "name": "Verde humo"
      },
      {
        "code": "304",
        "name": "Kaki oscuro"
      },
      {
        "code": "305",
        "name": "Melocoton"
      },
      {
        "code": "306",
        "name": "Amarillo mantequilla"
      },
      {
        "code": "307",
        "name": "Verde musgo"
      },
      {
        "code": "308",
        "name": "Azul oceano"
      },
      {
        "code": "309",
        "name": "Gris cemento"
      },
      {
        "code": "310",
        "name": "Verde oregano"
      },
      {
        "code": "311",
        "name": "Morado"
      },
      {
        "code": "312",
        "name": "Amarillo fortiplan"
      },
      {
        "code": "313",
        "name": "Marron claro"
      },
      {
        "code": "314",
        "name": "Oro"
      },
      {
        "code": "315",
        "name": "Amatista"
      },
      {
        "code": "316",
        "name": "Amarillo oro"
      },
      {
        "code": "317",
        "name": "Verde pistacho"
      },
      {
        "code": "318",
        "name": "Verde fluorescente"
      },
      {
        "code": "319",
        "name": "Amarillo fluorescente"
      },
      {
        "code": "320",
        "name": "Fucsia fluorescente"
      },
      {
        "code": "321",
        "name": "Naranja fluorescente"
      },
      {
        "code": "322",
        "name": "Chiclets"
      },
      {
        "code": "323",
        "name": "Verde manzana medio"
      },
      {
        "code": "324",
        "name": "Verde acadia"
      },
      {
        "code": "400",
        "name": "Amarillo citrico"
      },
      {
        "code": "401",
        "name": "Amarillo bandera"
      },
      {
        "code": "402",
        "name": "Amarillo caterpillar"
      },
      {
        "code": "403",
        "name": "Mostaza"
      },
      {
        "code": "404",
        "name": "Azul royal"
      },
      {
        "code": "405",
        "name": "Azul rey"
      },
      {
        "code": "406",
        "name": "Turqueza"
      },
      {
        "code": "407",
        "name": "Aguas profundas"
      },
      {
        "code": "408",
        "name": "Azul petroleo"
      },
      {
        "code": "409",
        "name": "Azul marino"
      },
      {
        "code": "410",
        "name": "Azul piedra"
      },
      {
        "code": "411",
        "name": "Verde benettone"
      },
      {
        "code": "412",
        "name": "Verde menta"
      },
      {
        "code": "413",
        "name": "Verde botella"
      },
      {
        "code": "414",
        "name": "Verde manzana"
      },
      {
        "code": "415",
        "name": "Verde militar"
      },
      {
        "code": "416",
        "name": "Vinotinto"
      },
      {
        "code": "417",
        "name": "Rojo"
      },
      {
        "code": "418",
        "name": "Fucsia"
      },
      {
        "code": "419",
        "name": "Ladrillo"
      },
      {
        "code": "420",
        "name": "Naranja"
      },
      {
        "code": "421",
        "name": "Melange"
      },
      {
        "code": "422",
        "name": "Gris plomo"
      },
      {
        "code": "423",
        "name": "Gris raton"
      },
      {
        "code": "424",
        "name": "Negro"
      },
      {
        "code": "425",
        "name": "Chocolate"
      },
      {
        "code": "426",
        "name": "Avellana"
      },
      {
        "code": "427",
        "name": "Cimarron"
      },
      {
        "code": "428",
        "name": "Amarillo mostaza"
      },
      {
        "code": "429",
        "name": "Terracota"
      },
      {
        "code": "430",
        "name": "Coral"
      },
      {
        "code": "431",
        "name": "Cidra"
      },
      {
        "code": "432",
        "name": "Tabaco"
      },
      {
        "code": "433",
        "name": "Verde charllot"
      },
      {
        "code": "434",
        "name": "Nazareno"
      },
      {
        "code": "435",
        "name": "Naranja fuego"
      },
      {
        "code": "436",
        "name": "Rojo cayena"
      },
      {
        "code": "437",
        "name": "Verde loro"
      },
      {
        "code": "438",
        "name": "Gris oscuro"
      },
      {
        "code": "439",
        "name": "Pink"
      },
      {
        "code": "440",
        "name": "Rojo manzana"
      },
      {
        "code": "441",
        "name": "Menta oscuro"
      },
      {
        "code": "442",
        "name": "Chili red"
      },
      {
        "code": "443",
        "name": "Verde esmeralda"
      },
      {
        "code": "444",
        "name": "Azul principe"
      },
      {
        "code": "445",
        "name": "Negro chocolate"
      },
      {
        "code": "446",
        "name": "Chile papa"
      },
      {
        "code": "447",
        "name": "Azul zafiro"
      },
      {
        "code": "448",
        "name": "Verde forest"
      },
      {
        "code": "449",
        "name": "Azul noche"
      }
    ],
    "notes": "Transcrito de fotos de la carta física (docs/carta de colores.pdf, 2026-08-15). Etiquetas parcialmente cortadas en la foto — confirmar con el cliente: 444 «Azul principe», 446 «Chile papa», 448 «Verde forest», 449 «Azul noche». MELANGE (421) lleva código de oscuro pero la lista de precios lo agrupa con los medios («MEDIOS Y MELANGE»).",
    "source": "carta de colores.pdf",
    "lastUpdate": "2026-08-15T00:00:00.000Z"
  },
  {
    "_id": "config:catalog",
    "type": "config",
    "note": "Catálogo cerrado de telas y grosores (cliente, 2026-08-15: «ya tiene todas las telas, colores y NM's»). counts vacío = grosor libre (sin dato). productType sugiere la categoría al ingresar. Fuente: tablas NM/Dtex de las notas del cliente + lista de precios junio 2026.",
    "fabrics": [
      {
        "name": "Jersey",
        "productType": "ROLL",
        "counts": [
          "18/1",
          "20/1",
          "24/1",
          "30/1"
        ]
      },
      {
        "name": "Piqué",
        "productType": "ROLL",
        "counts": [
          "18/1",
          "20/1",
          "24/1",
          "30/1"
        ]
      },
      {
        "name": "Fleece",
        "productType": "ROLL",
        "counts": [
          "18/1",
          "20/1",
          "24/1"
        ]
      },
      {
        "name": "Ribb",
        "productType": "ROLL",
        "counts": [
          "20/1",
          "24/1",
          "30/1"
        ]
      },
      {
        "name": "Interlock",
        "productType": "ROLL",
        "counts": [
          "30/1",
          "40/1"
        ]
      },
      {
        "name": "Cottonlycra",
        "productType": "ROLL",
        "counts": [
          "18/1",
          "20/1",
          "24/1"
        ]
      },
      {
        "name": "Combo",
        "productType": "COMBO",
        "counts": [
          "18/1",
          "20/1",
          "24/1"
        ]
      },
      {
        "name": "Unipolo",
        "productType": "ROLL",
        "counts": [
          "150/1"
        ]
      },
      {
        "name": "Superpolo",
        "productType": "ROLL",
        "counts": [
          "150/1"
        ]
      },
      {
        "name": "Galleta",
        "productType": "ROLL",
        "counts": [
          "150/1"
        ]
      },
      {
        "name": "Atlética",
        "productType": "ROLL",
        "counts": [
          "150/1"
        ]
      },
      {
        "name": "Dry fit",
        "productType": "ROLL",
        "counts": [
          "100/1",
          "75/1"
        ]
      },
      {
        "name": "Poly Lycra",
        "productType": "ROLL",
        "counts": [
          "100/1",
          "75/1"
        ]
      },
      {
        "name": "Sabina",
        "productType": "ROLL",
        "counts": [
          "75/1"
        ]
      },
      {
        "name": "Muselina",
        "productType": "ROLL",
        "counts": []
      }
    ],
    "source": "docs/fabric-standards.md §3 + LISTA DE PRECIOS JUNIO 2026.pdf",
    "lastUpdate": "2026-08-15T00:00:00.000Z"
  },
  {
    "_id": "config:pricelist:tiendas",
    "type": "config",
    "listName": "LISTA DE PRECIO TIENDAS",
    "clientType": "tiendas",
    "validFrom": "2026-06",
    "note": "Precios por kg salvo CUELLOS Y PUÑOS (por combo). divisasUsd = pago en divisas; bsAtBcvUsd = pago en bolívares a tasa BCV, importe expresado en USD. comp6535 = 65% poliéster / 35% algodón; algodon100 = 100% algodón. Bandas de tono según la carta de colores: blanco+pasteles (100/2xx), medios+melange (3xx/421), oscuros (4xx).",
    "groups": [
      {
        "group": "JERSEY-RIBB 24/1 Y 20/1",
        "prices": [
          {
            "band": "BLANCO Y PASTELES",
            "comp6535": {
              "divisasUsd": 7.3,
              "bsAtBcvUsd": 11.5
            },
            "algodon100": {
              "divisasUsd": 11.0,
              "bsAtBcvUsd": 13.0
            }
          },
          {
            "band": "MEDIOS Y MELANGE",
            "comp6535": {
              "divisasUsd": 8.1,
              "bsAtBcvUsd": 12.5
            },
            "algodon100": {
              "divisasUsd": 12.0,
              "bsAtBcvUsd": 14.0
            }
          },
          {
            "band": "OSCUROS",
            "comp6535": {
              "divisasUsd": 9.0,
              "bsAtBcvUsd": 14.5
            },
            "algodon100": {
              "divisasUsd": 13.0,
              "bsAtBcvUsd": 15.0
            }
          }
        ]
      },
      {
        "group": "RIBB 24/1 SOLO",
        "prices": [
          {
            "band": "BLANCO Y PASTELES",
            "comp6535": {
              "divisasUsd": 7.5,
              "bsAtBcvUsd": 11.7
            },
            "algodon100": {
              "divisasUsd": 11.5,
              "bsAtBcvUsd": 13.5
            }
          },
          {
            "band": "MEDIOS Y MELANGE",
            "comp6535": {
              "divisasUsd": 8.3,
              "bsAtBcvUsd": 12.7
            },
            "algodon100": {
              "divisasUsd": 12.5,
              "bsAtBcvUsd": 14.5
            }
          },
          {
            "band": "OSCUROS",
            "comp6535": {
              "divisasUsd": 9.3,
              "bsAtBcvUsd": 14.7
            },
            "algodon100": {
              "divisasUsd": 13.5,
              "bsAtBcvUsd": 15.5
            }
          }
        ]
      },
      {
        "group": "PIQUET 24/1 Y 20/1",
        "prices": [
          {
            "band": "BLANCO Y PASTELES",
            "comp6535": {
              "divisasUsd": 7.3,
              "bsAtBcvUsd": 11.5
            },
            "algodon100": {
              "divisasUsd": 11.0,
              "bsAtBcvUsd": 13.0
            }
          },
          {
            "band": "MEDIOS Y MELANGE",
            "comp6535": {
              "divisasUsd": 8.1,
              "bsAtBcvUsd": 12.5
            },
            "algodon100": {
              "divisasUsd": 12.0,
              "bsAtBcvUsd": 14.0
            }
          },
          {
            "band": "OSCUROS",
            "comp6535": {
              "divisasUsd": 9.0,
              "bsAtBcvUsd": 14.5
            },
            "algodon100": {
              "divisasUsd": 13.0,
              "bsAtBcvUsd": 15.0
            }
          }
        ]
      },
      {
        "group": "CUELLOS Y PUÑOS",
        "unit": "combo",
        "prices": [
          {
            "band": "BLANCO Y PASTELES",
            "comp6535": {
              "divisasUsd": 1.0,
              "bsAtBcvUsd": 1.25
            },
            "algodon100": {
              "divisasUsd": 1.5,
              "bsAtBcvUsd": 2.0
            }
          },
          {
            "band": "MEDIOS Y MELANGE",
            "comp6535": {
              "divisasUsd": 1.0,
              "bsAtBcvUsd": 1.25
            },
            "algodon100": {
              "divisasUsd": 1.5,
              "bsAtBcvUsd": 2.0
            }
          },
          {
            "band": "OSCUROS",
            "comp6535": {
              "divisasUsd": 1.0,
              "bsAtBcvUsd": 1.25
            },
            "algodon100": {
              "divisasUsd": 1.5,
              "bsAtBcvUsd": 2.0
            }
          }
        ]
      },
      {
        "group": "JERSEY-RIBB 30/1",
        "prices": [
          {
            "band": "BLANCO Y PASTELES",
            "comp6535": {
              "divisasUsd": 7.2,
              "bsAtBcvUsd": 11.5
            }
          },
          {
            "band": "MEDIOS Y MELANGE",
            "comp6535": {
              "divisasUsd": 8.1,
              "bsAtBcvUsd": 12.5
            }
          },
          {
            "band": "OSCUROS",
            "comp6535": {
              "divisasUsd": 9.0,
              "bsAtBcvUsd": 14.5
            }
          }
        ]
      },
      {
        "group": "INTERLOCK RIBB 30/1",
        "prices": [
          {
            "band": "BLANCO Y PASTELES",
            "comp6535": {
              "divisasUsd": 8.0,
              "bsAtBcvUsd": 12.0
            }
          },
          {
            "band": "MEDIOS Y MELANGE",
            "comp6535": {
              "divisasUsd": 8.8,
              "bsAtBcvUsd": 13.0
            }
          },
          {
            "band": "OSCUROS",
            "comp6535": {
              "divisasUsd": 10.0,
              "bsAtBcvUsd": 15.0
            }
          }
        ]
      },
      {
        "group": "FLEECE 24/1",
        "prices": [
          {
            "band": "BLANCO Y PASTELES",
            "comp6535": {
              "divisasUsd": 7.8,
              "bsAtBcvUsd": 12.0
            }
          },
          {
            "band": "MEDIOS Y MELANGE",
            "comp6535": {
              "divisasUsd": 8.4,
              "bsAtBcvUsd": 13.0
            }
          },
          {
            "band": "OSCUROS",
            "comp6535": {
              "divisasUsd": 9.5,
              "bsAtBcvUsd": 15.0
            }
          }
        ]
      },
      {
        "group": "SABINA-ATLETICA-MUSELINA",
        "prices": [
          {
            "band": "BLANCO Y PASTELES",
            "comp6535": {
              "divisasUsd": 6.7,
              "bsAtBcvUsd": 10.5
            }
          },
          {
            "band": "OSCUROS",
            "comp6535": {
              "divisasUsd": 7.0,
              "bsAtBcvUsd": 11.5
            }
          }
        ]
      },
      {
        "group": "UNIPOLO PIQUET POLI",
        "prices": [
          {
            "band": "BLANCO Y PASTELES",
            "comp6535": {
              "divisasUsd": 6.0,
              "bsAtBcvUsd": 9.0
            }
          },
          {
            "band": "MEDIOS Y MELANGE",
            "comp6535": {
              "divisasUsd": 6.3,
              "bsAtBcvUsd": 10.0
            }
          },
          {
            "band": "OSCUROS",
            "comp6535": {
              "divisasUsd": 7.0,
              "bsAtBcvUsd": 11.0
            }
          }
        ]
      },
      {
        "group": "POLIESTER LICRA 75/1",
        "prices": [
          {
            "band": "BLANCO Y PASTELES",
            "comp6535": {
              "divisasUsd": 6.7,
              "bsAtBcvUsd": 10.5
            }
          },
          {
            "band": "OSCUROS",
            "comp6535": {
              "divisasUsd": 7.0,
              "bsAtBcvUsd": 11.5
            }
          }
        ]
      },
      {
        "group": "DRY-FIT",
        "prices": [
          {
            "band": "BLANCO Y PASTELES",
            "comp6535": {
              "divisasUsd": 6.5,
              "bsAtBcvUsd": 8.5
            },
            "importado": {
              "divisasUsd": 6.5,
              "bsAtBcvUsd": 8.5
            }
          },
          {
            "band": "OSCUROS",
            "comp6535": {
              "divisasUsd": 7.0,
              "bsAtBcvUsd": 9.5
            }
          }
        ]
      },
      {
        "group": "IMPORTADOS",
        "prices": [
          {
            "band": "FLEECE AZUL MARINO",
            "comp6535": {
              "divisasUsd": 6.2,
              "bsAtBcvUsd": 8.0
            }
          },
          {
            "band": "POLYLICRA BLANCA",
            "comp6535": {
              "divisasUsd": 5.5,
              "bsAtBcvUsd": 7.0
            }
          }
        ]
      }
    ],
    "source": "LISTA DE PRECIOS JUNIO 2026.pdf",
    "lastUpdate": "2026-08-15T00:00:00.000Z"
  }
] as const;
