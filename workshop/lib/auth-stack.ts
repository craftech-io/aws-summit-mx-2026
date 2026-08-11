// Login por SMS sin contraseña, con el flujo CUSTOM_AUTH de Cognito.
//
// Cognito no trae "OTP por SMS" como flujo listo: se arma con tres triggers.
//   defineAuthChallenge  → decide qué desafío toca y cuándo termina
//   createAuthChallenge  → genera el código y lo manda por SNS
//   verifyAuthChallenge  → compara lo que tipeó el usuario
import * as cdk from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import * as path from "path";

export interface AuthStackProps extends cdk.StackProps {
  prefijo: string;
}

export class AuthStack extends cdk.Stack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);

    const rutaLambda = (nombre: string) =>
      path.join(__dirname, "..", "lambda", "auth", `${nombre}.ts`);

    const comun: Partial<nodejs.NodejsFunctionProps> = {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(10),
      bundling: { minify: false, sourceMap: true, format: nodejs.OutputFormat.ESM },
    };

    const definirDesafio = new nodejs.NodejsFunction(this, "DefinirDesafio", {
      ...comun,
      functionName: `${props.prefijo}-auth-definir`,
      entry: rutaLambda("define-challenge"),
    });

    const crearDesafio = new nodejs.NodejsFunction(this, "CrearDesafio", {
      ...comun,
      functionName: `${props.prefijo}-auth-crear`,
      entry: rutaLambda("create-challenge"),
      environment: {
        // En SNS sandbox solo se puede mandar SMS a números verificados.
        // Con MODO_DEMO=true el código también se devuelve en la respuesta
        // para que el laboratorio no se trabe si el SMS no sale.
        MODO_DEMO: "true",
      },
    });
    crearDesafio.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["sns:Publish"],
        resources: ["*"], // SMS a un número no tiene ARN de recurso
      }),
    );

    const verificarDesafio = new nodejs.NodejsFunction(this, "VerificarDesafio", {
      ...comun,
      functionName: `${props.prefijo}-auth-verificar`,
      entry: rutaLambda("verify-challenge"),
    });

    // Sin contraseña no hay paso de confirmación separado: la prueba de
    // identidad es el SMS. Este trigger confirma el alta en el momento.
    const preRegistro = new nodejs.NodejsFunction(this, "PreRegistro", {
      ...comun,
      functionName: `${props.prefijo}-auth-pre-registro`,
      entry: rutaLambda("pre-signup"),
    });

    this.userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: `${props.prefijo}-usuarios`,
      selfSignUpEnabled: true,
      signInAliases: { phone: true },
      standardAttributes: {
        phoneNumber: { required: true, mutable: true },
      },
      // La contraseña existe pero nunca se usa: el ingreso es por SMS.
      passwordPolicy: {
        minLength: 16,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      autoVerify: { phone: false },
      lambdaTriggers: {
        preSignUp: preRegistro,
        defineAuthChallenge: definirDesafio,
        createAuthChallenge: crearDesafio,
        verifyAuthChallengeResponse: verificarDesafio,
      },
      accountRecovery: cognito.AccountRecovery.PHONE_ONLY_WITHOUT_MFA,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.userPoolClient = new cognito.UserPoolClient(this, "UserPoolClient", {
      userPool: this.userPool,
      userPoolClientName: `${props.prefijo}-web`,
      generateSecret: false,
      authFlows: {
        custom: true, // CUSTOM_AUTH: el flujo de OTP por SMS
        userSrp: false,
        userPassword: false,
        adminUserPassword: false,
      },
      preventUserExistenceErrors: true,
      accessTokenValidity: cdk.Duration.hours(8),
      idTokenValidity: cdk.Duration.hours(8),
      refreshTokenValidity: cdk.Duration.days(30),
    });

    new cdk.CfnOutput(this, "UserPoolId", { value: this.userPool.userPoolId });
    new cdk.CfnOutput(this, "UserPoolClientId", {
      value: this.userPoolClient.userPoolClientId,
    });
  }
}
