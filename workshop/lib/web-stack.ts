// Sitio estático: S3 privado + CloudFront con OAC. La interfaz es la app
// React compartida de webapp/ (la misma que usa la versión full Bedrock),
// compilada con Vite; este stack solo publica el build y su config.
import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import { Construct } from "constructs";
import * as fs from "fs";
import * as path from "path";

export interface WebStackProps extends cdk.StackProps {
  prefijo: string;
  apiUrl: string;
  chatUrl: string;
  userPoolId: string;
  userPoolClientId: string;
}

export class WebStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props);

    const bucket = new s3.Bucket(this, "SitioWeb", {
      bucketName: `${props.prefijo}-web-${this.account}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const distribucion = new cloudfront.Distribution(this, "Distribucion", {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      defaultRootObject: "index.html",
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: "/index.html" },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: "/index.html" },
      ],
      comment: `${props.prefijo} — agente de atención al cliente`,
    });

    // La configuración se inyecta como archivo aparte para no tener que
    // recompilar el front: la app la lee de window.CONFIG. El `modo` decide
    // qué interfaz muestra la webapp compartida (acá, la del loop a mano).
    const config = {
      modo: "lambda",
      apiUrl: props.apiUrl,
      chatUrl: props.chatUrl,
      userPoolId: props.userPoolId,
      userPoolClientId: props.userPoolClientId,
      region: this.region,
    };

    const dist = path.join(__dirname, "..", "..", "webapp", "dist");
    if (!fs.existsSync(path.join(dist, "index.html"))) {
      throw new Error(
        "Falta el build del front. Corré primero:  cd ../webapp && npm install && npm run build",
      );
    }

    new s3deploy.BucketDeployment(this, "DesplegarWeb", {
      sources: [
        s3deploy.Source.asset(dist),
        s3deploy.Source.data("config.js", `window.CONFIG = ${JSON.stringify(config, null, 2)};`),
      ],
      destinationBucket: bucket,
      distribution: distribucion,
      distributionPaths: ["/*"],
      prune: true,
    });

    new cdk.CfnOutput(this, "UrlSitio", {
      value: `https://${distribucion.distributionDomainName}`,
      description: "Abrí esta URL para usar el agente",
    });
  }
}
